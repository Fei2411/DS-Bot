import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createComputerIndicator, indicatorHtml } from '../src/computer-indicator.mjs'

function fakeElectron() {
  const windows = []
  class FakeWindow {
    constructor(options) {
      this.options = options
      this.listeners = new Map()
      this.webContents = { on: (name, fn) => { this.web = { ...this.web, [name]: fn } }, send: () => {}, loadURL: async () => {} }
      this.once = (name, fn) => { this.listeners.set(name, fn) }
      this.on = (name, fn) => { this.listeners.set(name, fn) }
      this.actions = []
      windows.push(this)
    }
    setContentProtection(on) { this.protection = on }
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
  indicator.update([{ label: 'River · Notes', botId: 'w1' }])
  assert.equal(windows.length, 1)
  const [win] = windows
  assert.equal(win.options.frame, false)
  assert.equal(win.options.transparent, true)
  assert.equal(win.options.alwaysOnTop, true)
  assert.equal(win.options.focusable, false)
  assert.equal(win.protection, true)
  assert.equal(win.workspaces, true)
  // top center of the primary display
  assert.equal(win.options.x, Math.round((1440 - 520) / 2))
  assert.equal(win.options.y, 8)
  indicator.dispose()
  assert.equal(win.closed, true)
})

test('empty entries hide the window; button clicks reach onAction', async () => {
  const { BrowserWindow, screen, windows } = fakeElectron()
  const actions = []
  const indicator = createComputerIndicator({ BrowserWindow, screen, html: indicatorHtml, onAction: (kind, botId) => actions.push([kind, botId]), log: { warn: () => {} } })
  indicator.update([{ label: 'River · Notes', botId: 'w1' }])
  const [win] = windows
  win.web['console-message'](null, 3, 'dsbot-computer:stop:w1')
  win.web['console-message'](null, 3, 'dsbot-computer:stopall:')
  win.web['console-message'](null, 3, 'dsbot-computer:letgo:m1')
  win.web['console-message'](null, 3, 'console noise')
  assert.deepEqual(actions, [['stop', 'w1'], ['stopall', null], ['letgo', 'm1']])
  indicator.update([])
  assert.equal(win.closed, true)
})

test('the page lists every entry with its own stop and escapes markup', () => {
  const page = indicatorHtml([{ label: 'River · <img>', botId: 'w1' }, { label: 'Chief · Mail', botId: 'm1' }, { label: 'Writer waits', botId: 'w2', waiting: true }])
  assert.match(page, /River · &lt;img&gt;/)
  assert.match(page, /data-act="stop:w1"/)
  assert.match(page, /data-act="stop:m1"/)
  assert.match(page, /data-act="letgo:w2"/)
  assert.match(page, /data-act="stopall:"/)
  assert.doesNotMatch(page, /<img>/)
  const one = indicatorHtml([{ label: 'River · Notes', botId: 'w1' }])
  assert.doesNotMatch(one, /stopall/)
})
