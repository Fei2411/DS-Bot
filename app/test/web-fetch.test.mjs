import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, test } from 'node:test'
import { createWebFetchBridge } from '../src/web-fetch.mjs'

function createFakeElectron({ onLoad } = {}) {
  const partitionMap = new Map()
  const windows = []
  const session = {
    fromPartition(name) {
      let ses = partitionMap.get(name)
      if (!ses) {
        ses = new EventEmitter()
        ses.name = name
        ses.clearStorageCount = 0
        ses.clearCacheCount = 0
        ses.clearAuthCacheCount = 0
        ses.permissionDecisions = []
        ses.beforeRequestHandler = null
        ses.headersReceivedHandler = null
        ses.completedHandler = null
        ses.setPermissionRequestHandler = (fn) => { ses.permissionHandler = fn }
        ses.setPermissionCheckHandler = (fn) => { ses.permissionCheckHandler = fn }
        ses.clearStorageData = async () => { ses.clearStorageCount += 1 }
        ses.clearCache = async () => { ses.clearCacheCount += 1 }
        ses.clearAuthCache = async () => { ses.clearAuthCacheCount += 1 }
        ses.webRequest = {
          onBeforeRequest: (fn) => { ses.beforeRequestHandler = fn },
          onHeadersReceived: (fn) => { ses.headersReceivedHandler = fn },
          onCompleted: (fn) => { ses.completedHandler = fn },
        }
        partitionMap.set(name, ses)
      }
      return ses
    },
  }

  class FakeBrowserWindow {
    constructor(options) {
      this.options = options
      this.destroyed = false
      this.audioMuted = false
      this.webContents = new EventEmitter()
      this.webContents.currentUrl = ''
      this.webContents.setAudioMuted = (muted) => { this.audioMuted = muted }
      this.webContents.setWindowOpenHandler = (fn) => { this.windowOpenHandler = fn }
      this.webContents.getURL = () => this.webContents.currentUrl
      this.webContents.loadURL = async (url) => {
        this.webContents.currentUrl = url
        const ses = options.webPreferences.session
        await onLoad({ win: this, wc: this.webContents, ses, url })
      }
      this.webContents.executeJavaScript = async (script) => {
        if (typeof this._eval === 'function') return this._eval(script)
        return { url: this.webContents.currentUrl, contentType: 'text/html', html: '<html><body>Default</body></html>', text: 'Default' }
      }
      windows.push(this)
    }
    isDestroyed() { return this.destroyed }
    destroy() {
      this.destroyed = true
      this.webContents.emit('destroyed')
    }
  }

  return { BrowserWindow: FakeBrowserWindow, session, partitionMap, windows }
}

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }]

describe('createWebFetchBridge', () => {
  test('renders page in bounded non-persistent partition pool, hardens window, and unbinds/clears on release', async () => {
    const electron = createFakeElectron({
      async onLoad({ win, wc, ses, url }) {
        assert.ok(!ses.name.startsWith('persist:'))
        assert.match(ses.name, /^web-fetch-slot-\d+$/)
        assert.equal(win.options.show, false)
        assert.equal(win.options.skipTaskbar, true)
        assert.equal(win.options.focusable, false)
        assert.equal(win.audioMuted, true)
        assert.equal(win.options.webPreferences.sandbox, true)
        assert.equal(win.options.webPreferences.contextIsolation, true)
        assert.equal(win.options.webPreferences.nodeIntegration, false)
        assert.deepEqual(win.windowOpenHandler(), { action: 'deny' })
        assert.equal(ses.permissionCheckHandler(), false)
        ses.permissionHandler(wc, 'geolocation', decision => ses.permissionDecisions.push(decision))

        ses.completedHandler?.({ resourceType: 'mainFrame', statusCode: 200, responseHeaders: { 'Content-Type': ['text/html; charset=utf-8'] } })
        win._eval = (script) => {
          if (script.includes('innerText || \'\').trim().length')) return 420
          return {
            url,
            contentType: 'text/html',
            html: '<html><body><h1>Bybit AI Trading</h1><p>Rendered article</p></body></html>',
            text: 'Bybit AI Trading Rendered article',
          }
        }
        queueMicrotask(() => wc.emit('did-finish-load'))
      },
    })

    const bridge = createWebFetchBridge({
      BrowserWindow: electron.BrowserWindow,
      session: electron.session,
      lookup: publicLookup,
      maxConcurrent: 2,
      settlePollMs: 5,
      maxSettleWaitMs: 30,
    })

    for (let i = 0; i < 4; i += 1) {
      const response = await new Promise((resolve) => {
        assert.equal(bridge.handle({ type: 'ds-bot:web-fetch', id: `req-${i}`, url: 'https://www.bybit.com/en/help', timeoutMs: 5000, maxBodyChars: 50000 }, resolve), true)
      })
      assert.equal(response.result.statusCode, 200)
      assert.match(response.result.body.content, /Rendered article/)
    }

    // Bounded pool: 4 sequential requests never create more than maxConcurrent partitions.
    assert.ok(electron.partitionMap.size <= 2)
    for (const ses of electron.partitionMap.values()) {
      assert.equal(ses.beforeRequestHandler, null, 'webRequest onBeforeRequest must be unbound')
      assert.equal(ses.headersReceivedHandler, null, 'webRequest onHeadersReceived must be unbound')
      assert.equal(ses.completedHandler, null, 'webRequest onCompleted must be unbound')
      assert.equal(ses.listenerCount('will-download'), 0, 'will-download listener must be removed')
      assert.ok(ses.clearStorageCount > 0 && ses.clearCacheCount > 0 && ses.clearAuthCacheCount > 0)
    }
    bridge.close()
  })

  test('releases concurrency slots after aborts and timeouts so later fetches never deadlock', async () => {
    let hang = true
    const electron = createFakeElectron({
      async onLoad({ win, wc, ses, url }) {
        if (hang) return
        ses.completedHandler?.({ resourceType: 'mainFrame', statusCode: 200, responseHeaders: { 'content-type': ['text/html'] } })
        win._eval = () => ({ url, contentType: 'text/html', html: '<h1>Recovered</h1>', text: 'Recovered' })
        queueMicrotask(() => wc.emit('did-finish-load'))
      },
    })
    const bridge = createWebFetchBridge({
      BrowserWindow: electron.BrowserWindow,
      session: electron.session,
      lookup: publicLookup,
      maxConcurrent: 2,
    })

    // Abort two requests (filling all 2 slots).
    const p1 = new Promise(resolve => bridge.handle({ type: 'ds-bot:web-fetch', id: 'a1', url: 'https://example.com/1', timeoutMs: 10000 }, resolve))
    const p2 = new Promise(resolve => bridge.handle({ type: 'ds-bot:web-fetch', id: 'a2', url: 'https://example.com/2', timeoutMs: 10000 }, resolve))
    await new Promise(r => setTimeout(r, 15))
    bridge.handle({ type: 'ds-bot:web-fetch-abort', id: 'a1' }, () => {})
    bridge.handle({ type: 'ds-bot:web-fetch-abort', id: 'a2' }, () => {})
    const [r1, r2] = await Promise.all([p1, p2])
    assert.equal(r1.code, 'WEB_ABORTED')
    assert.equal(r2.code, 'WEB_ABORTED')

    // Next request must run and succeed immediately (slots were released).
    hang = false
    const r3 = await new Promise(resolve => bridge.handle({ type: 'ds-bot:web-fetch', id: 'a3', url: 'https://example.com/3', timeoutMs: 5000 }, resolve))
    assert.equal(r3.result.statusCode, 200)
    assert.match(r3.result.body.content, /Recovered/)
    bridge.close()
  })

  test('rejects will-download and unsupported binary MIME immediately with WEB_UNSUPPORTED_CONTENT_TYPE', async () => {
    let mode = 'download'
    let downloadCanceled = false
    const electron = createFakeElectron({
      async onLoad({ wc, ses }) {
        if (mode === 'download') {
          ses.emit('will-download', {}, { cancel() { downloadCanceled = true } })
          return
        }
        let canceled = false
        ses.headersReceivedHandler?.({
          resourceType: 'mainFrame',
          statusCode: 200,
          ip: '93.184.216.34',
          responseHeaders: { 'Content-Type': ['application/pdf'] },
        }, ({ cancel }) => { canceled = cancel })
        assert.equal(canceled, true)
        queueMicrotask(() => wc.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://example.com/a.pdf', true))
      },
    })
    const bridge = createWebFetchBridge({ BrowserWindow: electron.BrowserWindow, session: electron.session, lookup: publicLookup })

    const dl = await new Promise(resolve => bridge.handle({ type: 'ds-bot:web-fetch', id: 'dl-1', url: 'https://example.com/archive.zip', timeoutMs: 5000 }, resolve))
    assert.equal(downloadCanceled, true)
    assert.equal(dl.code, 'WEB_UNSUPPORTED_CONTENT_TYPE')

    mode = 'pdf'
    const pdf = await new Promise(resolve => bridge.handle({ type: 'ds-bot:web-fetch', id: 'pdf-1', url: 'https://example.com/a.pdf', timeoutMs: 5000 }, resolve))
    assert.equal(pdf.code, 'WEB_UNSUPPORTED_CONTENT_TYPE')
    bridge.close()
  })

  test('blocks literal, DNS-resolved, IP-header, credentialed, and mainFrame data: SSRF attempts', async () => {
    const electron = createFakeElectron({
      async onLoad({ wc, ses }) {
        // 1. mainFrame data: URL blocked
        let dataBlocked = false
        ses.beforeRequestHandler({ url: 'data:text/html,<h1>x</h1>', resourceType: 'mainFrame' }, ({ cancel }) => { dataBlocked = cancel })
        assert.equal(dataBlocked, true)

        // 2. Credentialed URL blocked
        let credBlocked = false
        ses.beforeRequestHandler({ url: 'https://user:pass@example.com/', resourceType: 'mainFrame' }, ({ cancel }) => { credBlocked = cancel })
        assert.equal(credBlocked, true)

        // 3. DNS-resolved private target blocked
        const dnsBlocked = await new Promise((resolve) => {
          ses.beforeRequestHandler({ url: 'https://rebind.nip.io/admin', resourceType: 'mainFrame' }, ({ cancel }) => resolve(cancel))
        })
        assert.equal(dnsBlocked, true)

        // 4. Private IP reported in onHeadersReceived blocked
        let ipBlocked = false
        ses.headersReceivedHandler({ resourceType: 'subFrame', statusCode: 200, ip: '127.0.0.1', responseHeaders: {} }, ({ cancel }) => { ipBlocked = cancel })
        assert.equal(ipBlocked, true)

        queueMicrotask(() => wc.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://rebind.nip.io/admin', true))
      },
    })

    const bridge = createWebFetchBridge({
      BrowserWindow: electron.BrowserWindow,
      session: electron.session,
      lookup: async (host) => host.includes('rebind') ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '93.184.216.34', family: 4 }],
    })
    const response = await new Promise((resolve) => {
      bridge.handle({ type: 'ds-bot:web-fetch', id: 'req-ssrf', url: 'https://public.example.com/jump', timeoutMs: 5000, maxBodyChars: 10000 }, resolve)
    })
    assert.equal(response.code, 'WEB_REDIRECT_BLOCKED')
    assert.match(response.error, /private address/i)
    assert.equal(electron.windows[0].destroyed, true)
    bridge.close()
  })

  test('fails fast when a main-frame redirect is cancelled for credentials or foreign scheme', async () => {
    let target = 'https://user:pass@example.com/secret'
    const electron = createFakeElectron({
      async onLoad({ wc, ses }) {
        let canceled = false
        ses.beforeRequestHandler({ url: target, resourceType: 'mainFrame' }, ({ cancel }) => { canceled = cancel })
        assert.equal(canceled, true)
        queueMicrotask(() => wc.emit('did-fail-load', {}, -3, 'ERR_ABORTED', target, true))
      },
    })
    const bridge = createWebFetchBridge({ BrowserWindow: electron.BrowserWindow, session: electron.session, lookup: publicLookup })

    const cred = await new Promise(resolve => bridge.handle({ type: 'ds-bot:web-fetch', id: 'c1', url: 'https://example.com/start', timeoutMs: 5000 }, resolve))
    assert.equal(cred.code, 'WEB_BLOCKED_URL')

    target = 'file:///etc/passwd'
    const scheme = await new Promise(resolve => bridge.handle({ type: 'ds-bot:web-fetch', id: 'c2', url: 'https://example.com/start', timeoutMs: 5000 }, resolve))
    assert.equal(scheme.code, 'WEB_INVALID_URL')
    bridge.close()
  })

  test('ignores unrelated IPC messages and truncates oversized text responses', async () => {
    const electron = createFakeElectron({
      async onLoad({ win, wc, ses, url }) {
        ses.completedHandler?.({ resourceType: 'mainFrame', statusCode: 200, responseHeaders: { 'content-type': ['application/json'] } })
        win._eval = () => ({ url, contentType: 'application/json', html: '', text: 'x'.repeat(2500) })
        queueMicrotask(() => wc.emit('did-finish-load'))
      },
    })
    const bridge = createWebFetchBridge({ BrowserWindow: electron.BrowserWindow, session: electron.session, lookup: publicLookup })
    assert.equal(bridge.handle({ type: 'ds-bot:other', id: '1' }, () => {}), false)

    const response = await new Promise((resolve) => {
      bridge.handle({ type: 'ds-bot:web-fetch', id: 'req-json', url: 'https://api.example.com/data', timeoutMs: 5000, maxBodyChars: 1200 }, resolve)
    })
    assert.equal(response.result.body.kind, 'text')
    assert.equal(response.result.body.content.length, 1200)
    assert.equal(response.result.truncated, true)
    bridge.close()
  })
})
