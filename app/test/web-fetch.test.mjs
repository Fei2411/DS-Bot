import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, test } from 'node:test'
import { createWebFetchBridge } from '../src/web-fetch.mjs'

function createFakeElectron({ onLoad } = {}) {
  const partitions = []
  const windows = []
  const session = {
    fromPartition(name) {
      const ses = new EventEmitter()
      ses.name = name
      ses.clearedStorage = false
      ses.clearedCache = false
      ses.permissionDecisions = []
      ses.beforeRequestHandlers = []
      ses.completedHandlers = []
      ses.setPermissionRequestHandler = (fn) => { ses.permissionHandler = fn }
      ses.clearStorageData = async () => { ses.clearedStorage = true }
      ses.clearCache = async () => { ses.clearedCache = true }
      ses.webRequest = {
        onBeforeRequest: (fn) => { ses.beforeRequestHandlers.push(fn) },
        onCompleted: (fn) => { ses.completedHandlers.push(fn) },
      }
      partitions.push(ses)
      return ses
    },
  }

  class FakeBrowserWindow {
    constructor(options) {
      this.options = options
      this.destroyed = false
      this.webContents = new EventEmitter()
      this.webContents.currentUrl = ''
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
    destroy() { this.destroyed = true }
  }

  return { BrowserWindow: FakeBrowserWindow, session, partitions, windows }
}

describe('createWebFetchBridge', () => {
  test('renders page in ephemeral non-persistent partition, denies popups/permissions/downloads, and cleans up', async () => {
    let downloadCanceled = false
    const electron = createFakeElectron({
      async onLoad({ win, wc, ses, url }) {
        // Verify non-persistent partition and security hardening.
        assert.ok(!ses.name.startsWith('persist:'))
        assert.equal(win.options.show, false)
        assert.equal(win.options.webPreferences.sandbox, true)
        assert.equal(win.options.webPreferences.contextIsolation, true)
        assert.equal(win.options.webPreferences.nodeIntegration, false)
        assert.deepEqual(win.windowOpenHandler(), { action: 'deny' })
        ses.permissionHandler(wc, 'geolocation', decision => ses.permissionDecisions.push(decision))
        ses.emit('will-download', {}, { cancel() { downloadCanceled = true } })

        for (const fn of ses.completedHandlers) {
          fn({ resourceType: 'mainFrame', statusCode: 200, responseHeaders: { 'Content-Type': ['text/html; charset=utf-8'] } })
        }
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

    const bridge = createWebFetchBridge({ BrowserWindow: electron.BrowserWindow, session: electron.session, settlePollMs: 5, maxSettleWaitMs: 30 })
    const response = await new Promise((resolve) => {
      assert.equal(bridge.handle({ type: 'ds-bot:web-fetch', id: 'req-1', url: 'https://www.bybit.com/en/help', timeoutMs: 5000, maxBodyChars: 50000 }, resolve), true)
    })

    assert.equal(response.type, 'ds-bot:web-fetch-response')
    assert.equal(response.id, 'req-1')
    assert.equal(response.result.statusCode, 200)
    assert.equal(response.result.body.kind, 'html')
    assert.match(response.result.body.content, /Rendered article/)
    assert.equal(electron.windows[0].destroyed, true)
    assert.equal(electron.partitions[0].clearedStorage, true)
    assert.equal(electron.partitions[0].clearedCache, true)
    assert.deepEqual(electron.partitions[0].permissionDecisions, [false])
    assert.equal(downloadCanceled, true)
    bridge.close()
  })

  test('blocks SSRF redirects from public URL to loopback/private host', async () => {
    const electron = createFakeElectron({
      async onLoad({ wc, ses }) {
        let blocked = false
        for (const fn of ses.beforeRequestHandlers) {
          fn({ url: 'http://127.0.0.1:8797/admin', resourceType: 'mainFrame' }, ({ cancel }) => { blocked = cancel })
        }
        assert.equal(blocked, true)
        queueMicrotask(() => wc.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'http://127.0.0.1:8797/admin', true))
      },
    })

    const bridge = createWebFetchBridge({ BrowserWindow: electron.BrowserWindow, session: electron.session })
    const response = await new Promise((resolve) => {
      bridge.handle({ type: 'ds-bot:web-fetch', id: 'req-ssrf', url: 'https://public.example.com/jump', timeoutMs: 5000, maxBodyChars: 10000 }, resolve)
    })
    assert.equal(response.code, 'WEB_REDIRECT_BLOCKED')
    assert.match(response.error, /private address/i)
    assert.equal(electron.windows[0].destroyed, true)
    bridge.close()
  })

  test('rejects invalid URLs immediately and supports aborting in-flight fetches', async () => {
    const electron = createFakeElectron({
      async onLoad() {
        // Intentionally never finishes until aborted.
      },
    })
    const bridge = createWebFetchBridge({ BrowserWindow: electron.BrowserWindow, session: electron.session })

    const invalid = await new Promise((resolve) => {
      bridge.handle({ type: 'ds-bot:web-fetch', id: 'req-bad', url: 'file:///etc/passwd' }, resolve)
    })
    assert.equal(invalid.code, 'WEB_INVALID_URL')

    const abortedPromise = new Promise((resolve) => {
      bridge.handle({ type: 'ds-bot:web-fetch', id: 'req-abort', url: 'https://example.com/slow', timeoutMs: 10000 }, resolve)
    })
    // Let the task start, then abort via IPC message.
    await new Promise(r => setTimeout(r, 10))
    assert.equal(bridge.handle({ type: 'ds-bot:web-fetch-abort', id: 'req-abort' }, () => {}), true)
    const aborted = await abortedPromise
    assert.equal(aborted.code, 'WEB_ABORTED')
    assert.equal(electron.windows[0].destroyed, true)
    bridge.close()
  })

  test('ignores unrelated IPC messages and truncates oversized text responses', async () => {
    const electron = createFakeElectron({
      async onLoad({ win, wc, ses, url }) {
        for (const fn of ses.completedHandlers) {
          fn({ resourceType: 'mainFrame', statusCode: 200, responseHeaders: { 'content-type': ['application/json'] } })
        }
        win._eval = () => ({ url, contentType: 'application/json', html: '', text: 'x'.repeat(2500) })
        queueMicrotask(() => wc.emit('did-finish-load'))
      },
    })
    const bridge = createWebFetchBridge({ BrowserWindow: electron.BrowserWindow, session: electron.session })
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
