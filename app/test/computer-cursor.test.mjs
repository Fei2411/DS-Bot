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

test('darwin point checker recycles osascript after maxChecks and skips spawning on non-integer pid', async () => {
  let spawns = 0
  let kills = 0
  const spawn = () => {
    spawns += 1
    const child = new EventEmitter()
    child.stdin = Object.assign(new EventEmitter(), {
      write: (line) => {
        const seq = line.trim().split(/\s+/)[3]
        queueMicrotask(() => child.stdout.emit('data', `${seq} y\n`))
      },
    })
    child.stdout = new EventEmitter()
    child.kill = () => { kills += 1; child.emit('exit') }
    return child
  }
  const checker = createPointChecker({ platform: 'darwin', spawn, idleMs: 0, maxChecks: 2, log: { warn: () => {} } })
  assert.equal(await checker.check(10, 20, undefined), false)
  assert.equal(spawns, 0, 'non-integer pid must not spawn helper')
  assert.equal(await checker.check(10, 20, 9), true)
  assert.equal(spawns, 1)
  assert.equal(kills, 0)
  assert.equal(await checker.check(11, 21, 9), true)
  assert.equal(kills, 1, 'helper recycles after maxChecks to bound OS memory')
  assert.equal(await checker.check(12, 22, 9), true)
  assert.equal(spawns, 2, 'next query spawns a fresh helper')
  checker.dispose()
})

test('pause() cancels queued checks so sleeping/locking never respawns the helper or opens a cursor', async () => {
  let spawns = 0
  const replies = []
  const spawn = () => {
    spawns += 1
    const child = new EventEmitter()
    child.stdin = Object.assign(new EventEmitter(), {
      write: (line) => {
        const seq = line.trim().split(/\s+/)[3]
        replies.push(() => child.stdout.emit('data', `${seq} y\n`))
      },
    })
    child.stdout = new EventEmitter()
    child.kill = () => { child.emit('exit') }
    return child
  }
  const { windows, BrowserWindow } = fakeElectron()
  const cursor = createComputerCursor({ BrowserWindow, screen, platform: 'darwin', spawn, log: { warn: () => {} } })
  const first = update(cursor, { x: 10, y: 20 })
  const second = update(cursor, { x: 30, y: 40 })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(spawns, 1)
  cursor.pause()
  await Promise.all([first, second])
  assert.equal(spawns, 1, 'queued checks cancelled by pause() must not respawn helper')
  assert.equal(windows.length, 0, 'paused cursor must not open overlay windows')
  cursor.dispose()
})

test('sequence ids drop stale late helper answers so slow responses never desync later checks', async () => {
  let child
  const writes = []
  const spawn = () => {
    child = new EventEmitter()
    child.stdin = { write: (line) => { writes.push(line.trim()) } }
    child.stdout = new EventEmitter()
    child.kill = () => { child.emit('exit') }
    return child
  }
  const checker = createPointChecker({ platform: 'darwin', spawn, log: { warn: () => {} } })
  // First check times out (>300ms) -> resolves false.
  const first = await checker.check(10, 20, 9)
  assert.equal(first, false)
  const firstSeq = writes[0].split(/\s+/)[3]
  // Second check starts; stale 'y' from firstSeq arrives first, then real 'n' for secondSeq.
  const secondPromise = checker.check(30, 40, 9)
  await new Promise(resolve => setImmediate(resolve))
  const secondSeq = writes[1].split(/\s+/)[3]
  assert.notEqual(firstSeq, secondSeq)
  child.stdout.emit('data', `${firstSeq} y\n`)
  child.stdout.emit('data', `${secondSeq} n\n`)
  assert.equal(await secondPromise, false, 'stale reply for timed-out seq must be ignored')
  checker.dispose()
})

test('point checker auto-exits after idleMs and respawns lazily on the next check', async () => {
  let spawns = 0
  let kills = 0
  const spawn = () => {
    spawns += 1
    const child = new EventEmitter()
    child.stdin = { write: (line) => {
      const seq = line.trim().split(/\s+/)[3]
      queueMicrotask(() => child.stdout.emit('data', `${seq} y\n`))
    } }
    child.stdout = new EventEmitter()
    child.kill = () => { kills += 1; child.emit('exit') }
    return child
  }
  const checker = createPointChecker({ platform: 'darwin', spawn, idleMs: 40, log: { warn: () => {} } })
  assert.equal(await checker.check(10, 20, 9), true)
  assert.equal(spawns, 1)
  assert.equal(kills, 0)
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(kills, 1, 'idle helper exits automatically')
  assert.equal(await checker.check(10, 20, 9), true)
  assert.equal(spawns, 2, 'helper respawns lazily when needed again')
  checker.dispose()
})

test('moving the cursor waits for initial loadURL before replaying ripple, retries failed loads, and honors dispose', async () => {
  const { windows, BrowserWindow } = fakeElectron()
  let loads = 0
  let resolveFirstLoad
  let failNextLoad = false
  class ControlledWindow extends BrowserWindow {
    constructor(opts) {
      super(opts)
      this.loadURL = (url) => {
        loads += 1
        this.url = url
        if (failNextLoad) { failNextLoad = false; return Promise.reject(new Error('load failed')) }
        if (loads === 1) return new Promise(resolve => { resolveFirstLoad = resolve })
        return Promise.resolve()
      }
    }
  }
  const cursor = createComputerCursor({ BrowserWindow: ControlledWindow, screen, platform: 'darwin', spawn: fakeSpawn(), log: { warn: () => {} } })
  await update(cursor, { x: 100, y: 200, color: '#22c55e', ripple: false })
  assert.equal(loads, 1)
  // Second update arrives while first loadURL is still in flight -> must wait before running ripple JS.
  await update(cursor, { x: 150, y: 250, color: '#22c55e', ripple: true })
  assert.equal(loads, 1, 'pure move/click with same visual skips reload')
  assert.equal(windows[0].js.length, 0, 'ripple JS waits until initial loadURL completes')
  resolveFirstLoad()
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(windows[0].js.some(code => code.includes('ring')), 'queued ripple replays once loadURL resolves')

  // Failed loadURL clears visualKey so the next identical update retries loadURL.
  failNextLoad = true
  await update(cursor, { x: 160, y: 260, color: '#ff0000', ripple: false })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(loads, 2)
  await update(cursor, { x: 170, y: 270, color: '#ff0000', ripple: false })
  assert.equal(loads, 3, 'failed visual load retries on next update')

  cursor.pause()
  assert.equal(windows[0].closed, true, 'pause() closes live cursor overlays')

  // Dispose while check() is still pending -> no window created when check resolves.
  const { windows: windows2, BrowserWindow: BW2 } = fakeElectron()
  let replyLater
  const delayedSpawn = () => {
    const child = new EventEmitter()
    child.stdin = { write: (line) => { const seq = line.trim().split(/\s+/)[3]; replyLater = () => child.stdout.emit('data', `${seq} y\n`) } }
    child.stdout = new EventEmitter()
    child.kill = () => {}
    return child
  }
  const cursor2 = createComputerCursor({ BrowserWindow: BW2, screen, platform: 'darwin', spawn: delayedSpawn, log: { warn: () => {} } })
  const pending = update(cursor2)
  await new Promise(resolve => setImmediate(resolve))
  cursor2.dispose()
  replyLater?.()
  await pending
  assert.equal(windows2.length, 0, 'disposed cursor must not open a window after check settles')
})
