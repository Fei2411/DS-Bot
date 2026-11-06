import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createComputerCursor, cursorHtml, createPointChecker } from '../src/computer-cursor.mjs'
import { EventEmitter } from 'node:events'

function fakeWindow() {
  const win = new EventEmitter()
  win.options = null
  win.bounds = null
  win.url = null
  win.js = []
  win.closed = false
  win.shown = false
  win.alwaysOnTopLevel = null
  win.ignored = null
  win.protected = undefined
  win.loadURL = (url) => { win.url = url; return Promise.resolve() }
  win.setBounds = (b) => { win.bounds = b }
  win.showInactive = () => { win.shown = true }
  win.isVisible = () => win.shown
  win.setAlwaysOnTop = (on, level) => { win.alwaysOnTopLevel = level }
  win.setIgnoreMouseEvents = (on, opts) => { win.ignored = on }
  win.setContentProtection = (on) => { win.protected = on }
  win.setVisibleOnAllWorkspaces = () => {}
  win.close = () => { win.closed = true; win.emit('closed') }
  win.webContents = { executeJavaScript: async code => win.js.push(code) }
  return win
}
function fakeElectron() {
  const windows = []
  class BrowserWindow { constructor(options) { const win = fakeWindow(); win.options = options; windows.push(win); return win } }
  return { windows, BrowserWindow }
}
// A fake point-checker child that answers from a list.
function fakeSpawn(answers = ['y']) {
  return () => {
    const child = new EventEmitter()
    child.stdin = { write: (line) => { const a = answers.length > 1 ? answers.shift() : answers[0]; queueMicrotask(() => child.stdout.emit('data', a + '\n')) } }
    child.stdout = new EventEmitter()
    child.kill = () => { child.killed = true; child.emit('exit') }
    return child
  }
}
const screen = { getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 900 }, workArea: { x: 0, y: 0 } }) }
const update = (cursor, ev) => cursor.update({ botId: 'w1', x: 100, y: 200, mode: 'point', ripple: true, pid: 9, color: '#22c55e', ...ev })

test('the cursor window is transparent, click-through and floats above apps', async () => {
  const { windows, BrowserWindow } = fakeElectron()
  const cursor = createComputerCursor({ BrowserWindow, screen, platform: 'darwin', spawn: fakeSpawn(), log: { warn: () => {} } })
  await update(cursor)
  const win = windows[0]
  assert.equal(win.options.transparent, true)
  assert.equal(win.options.frame, false)
  assert.equal(win.options.focusable, false)
  assert.equal(win.options.skipTaskbar, true)
  assert.equal(win.alwaysOnTopLevel, 'screen-saver')
  assert.equal(win.ignored, true)
  assert.equal(win.protected, undefined)
  cursor.dispose()
})

test('the window sits so the arrow tip lands on the point', async () => {
  const { windows, BrowserWindow } = fakeElectron()
  const cursor = createComputerCursor({ BrowserWindow, screen, platform: 'darwin', spawn: fakeSpawn(), log: { warn: () => {} } })
  await update(cursor, { x: 100, y: 200 })
  assert.equal(windows[0].bounds.x, 100 - 7)
  assert.equal(windows[0].bounds.y, 200 - 3)
  cursor.dispose()
})

test('a covered point draws nothing and hides a live cursor', async () => {
  const { windows, BrowserWindow } = fakeElectron()
  const cursor = createComputerCursor({ BrowserWindow, screen, platform: 'darwin', spawn: fakeSpawn(['n']), log: { warn: () => {} } })
  await update(cursor)
  assert.equal(windows.length, 0)
  // then visible once, then covered again → the window is destroyed
  const cursor2 = createComputerCursor({ BrowserWindow, screen, platform: 'darwin', spawn: fakeSpawn(['y', 'n']), log: { warn: () => {} } })
  await update(cursor2)
  assert.equal(windows.length, 1)
  await update(cursor2, { pid: 5 })
  assert.equal(windows[0].closed, true)
  cursor2.dispose()
})

test('darwin draws unprotected; win32 hides the cursor from captures', async () => {
  const { windows, BrowserWindow } = fakeElectron()
  const cursor = createComputerCursor({ BrowserWindow, screen, platform: 'win32', spawn: fakeSpawn(), log: { warn: () => {} } })
  await update(cursor)
  assert.equal(windows[0].protected, true)
  cursor.dispose()
})

test('linux has no on-screen cursor', async () => {
  const { BrowserWindow } = fakeElectron()
  const cursor = createComputerCursor({ BrowserWindow, screen, platform: 'linux', log: { warn: () => {} } })
  await update(cursor)
  const checker = createPointChecker({ platform: 'linux' })
  assert.equal(await checker.check(10, 10, 1), false)
  cursor.dispose()
})

test('a slow checker answer means do not draw', async () => {
  const { windows, BrowserWindow } = fakeElectron()
  const slow = () => { const child = new EventEmitter(); child.stdin = { write: () => {} }; child.stdout = new EventEmitter(); child.kill = () => {}; return child }
  const cursor = createComputerCursor({ BrowserWindow, screen, platform: 'darwin', spawn: slow, log: { warn: () => {} } })
  await update(cursor)
  assert.equal(windows.length, 0)
  cursor.dispose()
})

test('the checker kills its helper on dispose', () => {
  let killed = false
  const spawn = () => { const child = new EventEmitter(); child.stdin = { write: () => {} }; child.stdout = new EventEmitter(); child.kill = () => { killed = true }; return child }
  const checker = createPointChecker({ platform: 'darwin', spawn, log: { warn: () => {} } })
  void checker.check(1, 2, 3)
  checker.dispose()
  assert.equal(killed, true)
})

test('cursorHtml paints the arrow in the Bot color with the avatar and a ripple', () => {
  const page = cursorHtml({ color: '#22c55e', avatar: 'data:image/png;base64,aGk=', ripple: true })
  assert.match(page, /fill="#22c55e"/)
  assert.match(page, /class="ava"/)
  assert.match(page, /class="ring"/)
  const plain = cursorHtml({ color: 'red', ripple: false })
  assert.match(plain, /fill="#4d6bfe"/)
  assert.doesNotMatch(plain, /class="ring"/)
  assert.match(plain, /background:transparent/)
})
