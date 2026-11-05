import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createComputerIndicator, indicatorHtml, sanitizeEntry } from '../src/computer-indicator.mjs'

function fakeElectron() {
  const windows = []
  class FakeWindow {
    constructor(options) {
      this.options = options
      this.listeners = new Map()
      this.webContents = { on: (name, fn) => { this.web = { ...this.web, [name]: fn } }, send: () => {}, loadURL: async () => {}, executeJavaScript: async () => 120 }
      this.once = (name, fn) => { this.listeners.set(name, fn) }
      this.on = (name, fn) => { this.listeners.set(name, fn) }
      this.actions = []
      windows.push(this)
    }
    setContentProtection(on) { this.protection = on }
    setBounds(bounds) { this.bounds = bounds }
    setVisibleOnAllWorkspaces(on) { this.workspaces = on }
    showInactive() { this.shown = true }
    close() { this.closed = true; this.listeners.get('closed')?.() }
    loadURL(url) { this.url = url; return Promise.resolve() }
  }
  return {
    windows,
    BrowserWindow: FakeWindow,
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 900 }, workArea: { x: 0, y: 0 } }) },
  }
}

test('the indicator window is frameless, unfocusable, protected and centered', () => {
  const { BrowserWindow, screen, windows } = fakeElectron()
  const indicator = createComputerIndicator({ BrowserWindow, screen, html: indicatorHtml, log: { warn: () => {} } })
  indicator.update({ rows: [{ label: 'River · Notes', botId: 'w1' }], labels: {} })
  assert.equal(windows.length, 1)
  const [win] = windows
  assert.equal(win.options.frame, false)
  assert.equal(win.options.transparent, true)
  assert.equal(win.options.alwaysOnTop, true)
  assert.equal(win.options.focusable, false)
  assert.equal(win.protection, true)
  assert.equal(win.workspaces, true)
  // top center of the primary display
  assert.equal(win.options.width, 1440 - 64)
  assert.equal(win.options.x, Math.round((1440 - (1440 - 64)) / 2))
  assert.equal(win.options.y, 8)
  indicator.dispose()
  assert.equal(win.closed, true)
})

test('empty entries hide the window; button clicks reach onAction', async () => {
  const { BrowserWindow, screen, windows } = fakeElectron()
  const actions = []
  const listeners = {}
  const ipcMain = { on: (channel, fn) => { listeners[channel] = fn } }
  const indicator = createComputerIndicator({ BrowserWindow, screen, html: indicatorHtml, ipcMain, onAction: (kind, botId) => actions.push([kind, botId]), log: { warn: () => {} } })
  indicator.update({ rows: [{ label: 'River · Notes', botId: 'w1' }], labels: {} })
  const [win] = windows
  const act = listeners['ds-bot:computer-indicator:act']
  act({ sender: win.webContents }, 'stop', 'w1')
  act({ sender: win.webContents }, 'stopall', '')
  act({ sender: win.webContents }, 'letgo', 'm1')
  assert.deepEqual(actions, [['stop', 'w1'], ['stopall', null], ['letgo', 'm1']])
  indicator.update({ rows: [], labels: {} })
  assert.equal(win.closed, true)
})

test('the page lists every entry, escapes markup and uses the passed labels', () => {
  const labels = { stop: 'Stop', stopAll: 'Stop all', letGo: 'Let it continue' }
  const page = indicatorHtml([{ label: 'River · <img>', botId: 'w1' }, { label: 'Chief · Mail', botId: 'm1' }, { label: 'Writer waits', botId: 'w2', waiting: true }], labels)
  assert.match(page, /River · &lt;img&gt;/)
  assert.match(page, /data-act="stop:w1"/)
  assert.match(page, /data-act="stop:m1"/)
  assert.match(page, /data-act="letgo:w2"/)
  assert.match(page, /data-act="stopall:"/)
  assert.match(page, /aria-label="Stop"/)
  assert.match(page, /class="sq"/)
  assert.match(page, />Stop all</)
  assert.match(page, />Let it continue</)
  assert.doesNotMatch(page, /<img>/)
  const one = indicatorHtml([{ label: 'River · Notes', botId: 'w1' }], labels)
  assert.doesNotMatch(one, /stopall/)
  const zh = indicatorHtml([{ label: 'River · Notes', botId: 'w1' }], { stop: '停止' })
  assert.match(zh, /aria-label="停止"/)
  assert.match(page, /prefers-color-scheme/)
  assert.match(page, /class="bar"/)
})

test('button actions go over the dedicated channel and only from the indicator', () => {
  const { windows, BrowserWindow } = fakeElectron()
  const listeners = {}
  const ipcMain = { on: (channel, fn) => { listeners[channel] = fn } }
  const calls = []
  const indicator = createComputerIndicator({
    BrowserWindow,
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 800, height: 600 }, workArea: { x: 0, y: 0 } }) },
    html: () => '<html></html>',
    ipcMain,
    preload: '/tmp/preload.cjs',
    onAction: (kind, botId) => calls.push([kind, botId]),
    log: { warn: () => {} },
  })
  indicator.update({ rows: [{ label: 'Chief · Notes', botId: 'w1' }], labels: {} })
  const win = windows[0]
  assert.equal(win.options.webPreferences.preload, '/tmp/preload.cjs')
  const handler = listeners['ds-bot:computer-indicator:act']
  assert.equal(typeof handler, 'function')
  // another window's webContents may not send
  handler({ sender: {} }, 'stop', 'w1')
  assert.deepEqual(calls, [])
  handler({ sender: win.webContents }, 'stop', 'w1')
  assert.deepEqual(calls, [['stop', 'w1']])
  indicator.dispose()
})

test('a reopen keeps exactly one action listener, so one click acts once', () => {
  const { windows, BrowserWindow, screen } = fakeElectron()
  const listeners = {}
  const ipcMain = { on: (channel, fn) => { (listeners[channel] ??= []).push(fn) } }
  const calls = []
  const indicator = createComputerIndicator({
    BrowserWindow, screen, html: () => '<html></html>', ipcMain,
    onAction: (kind, botId) => calls.push(kind),
    log: { warn: () => {} },
  })
  indicator.update({ rows: [{ label: 'Chief · Notes', botId: 'w1' }], labels: {} })
  windows[0].close()
  indicator.update({ rows: [{ label: 'Chief · Notes', botId: 'w1' }], labels: {} })
  assert.equal(windows.length, 2)
  assert.equal(listeners['ds-bot:computer-indicator:act'].length, 1)
  listeners['ds-bot:computer-indicator:act'][0]({ sender: windows[1].webContents }, 'stop', 'w1')
  assert.deepEqual(calls, ['stop'])
  indicator.dispose()
})

test('rows are sanitized: hex color and bounded data-url avatar only', () => {
  const clean = sanitizeEntry({ botId: 'w1', label: 'River', name: 'River', app: 'Notes', color: '#3b82f6', avatar: 'data:image/png;base64,aGk=', extra: 'x' })
  assert.equal(clean.color, '#3b82f6')
  assert.equal(clean.avatar, 'data:image/png;base64,aGk=')
  assert.equal(clean.extra, undefined)
  assert.equal(sanitizeEntry({ label: 'a', color: 'red' }).color, undefined)
  assert.equal(sanitizeEntry({ label: 'a', color: 'url(evil)' }).color, undefined)
  assert.equal(sanitizeEntry({ label: 'a', avatar: 'data:text/html;base64,aGk=' }).avatar, undefined)
  assert.equal(sanitizeEntry({ label: 'a', avatar: 'data:image/png;base64,' + 'A'.repeat(13000) }).avatar, undefined)
  assert.equal(sanitizeEntry(null).label, '')
  const page = indicatorHtml([{ name: 'River', app: 'Notes', color: '#3b82f6', botId: 'w1' }], {})
  assert.match(page, /background:#3b82f6/)
  assert.match(page, /<b>River<\/b>/)
  assert.match(page, /<i>Notes<\/i>/)
})

test('the window resizes to the measured pill width after load', async () => {
  const { windows, BrowserWindow } = fakeElectron()
  const indicator = createComputerIndicator({ BrowserWindow, screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 900 }, workArea: { x: 0, y: 0 } }) }, html: () => '<html></html>', log: { warn: () => {} } })
  indicator.update({ rows: [{ label: 'River · Notes', botId: 'w1' }], labels: {} })
  await new Promise(resolve => setImmediate(resolve))
  const win = windows[0]
  assert.equal(win.bounds.width, 144)
  assert.equal(win.bounds.height, 48)
  assert.equal(win.bounds.x, Math.round((1440 - 144) / 2))
})
