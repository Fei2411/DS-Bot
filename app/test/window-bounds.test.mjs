import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  readWindowBounds,
  resolveRestoredBounds,
  watchWindowBounds,
  writeWindowBounds,
} from '../src/window-bounds.mjs'

function makeFakeWin(bounds = { x: 100, y: 100, width: 1200, height: 800 }) {
  const win = new EventEmitter()
  let rect = { ...bounds }
  let visible = false
  let minimized = false
  let maximized = false
  let fullScreen = false
  let destroyed = false
  Object.assign(win, {
    isDestroyed: () => destroyed,
    isVisible: () => visible,
    isMinimized: () => minimized,
    isMaximized: () => maximized,
    isFullScreen: () => fullScreen,
    getBounds: () => ({ ...rect }),
    getNormalBounds: () => ({ ...rect }),
    setRect(next) { rect = { ...rect, ...next } },
    setVisible(v) { visible = v; if (v) win.emit('show') },
    setMinimized(v) { minimized = v },
    setMaximized(v) { maximized = v; win.emit(v ? 'maximize' : 'unmaximize') },
    setFullScreen(v) { fullScreen = v },
    destroy() { destroyed = true; win.emit('closed') },
  })
  return win
}

test('readWindowBounds and writeWindowBounds round-trip valid bounds and reject corrupt or undersized data', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-bounds-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'window-bounds.json')

  assert.equal(readWindowBounds(file), undefined)

  writeFileSync(file, '{broken json')
  assert.equal(readWindowBounds(file), undefined)

  writeFileSync(file, JSON.stringify({ x: 0, y: 0, width: 200, height: 100 }))
  assert.equal(readWindowBounds(file), undefined, 'undersized bounds are rejected')

  assert.equal(writeWindowBounds(file, { x: 120.4, y: 80.6, width: 1180.2, height: 760.8, maximized: true }), true)
  assert.deepEqual(readWindowBounds(file), { x: 120, y: 81, width: 1180, height: 761, maximized: true })
})

test('resolveRestoredBounds restores secondary monitor, clamps off-screen/oversized rects, and centers when monitor is disconnected', () => {
  const primary = { workArea: { x: 0, y: 25, width: 1440, height: 875 } }
  const secondary = { workArea: { x: 1440, y: 0, width: 1920, height: 1080 } }

  // 1. Exact restore on secondary monitor.
  assert.deepEqual(
    resolveRestoredBounds({ x: 1600, y: 100, width: 1200, height: 800, maximized: false }, [primary, secondary], { primary }),
    { x: 1600, y: 100, width: 1200, height: 800, maximized: false },
  )

  // 2. Partially off-screen & oversized on primary -> clamped inside primary workArea.
  assert.deepEqual(
    resolveRestoredBounds({ x: -120, y: 0, width: 1800, height: 1000, maximized: true }, [primary], { primary }),
    { x: 0, y: 25, width: 1440, height: 875, maximized: true },
  )

  // 3. Secondary monitor unplugged -> zero overlap with primary -> centered on primary with clamped size.
  const recovered = resolveRestoredBounds({ x: 2000, y: 200, width: 1000, height: 700, maximized: false }, [primary], { primary })
  assert.deepEqual(recovered, {
    x: 0 + Math.round((1440 - 1000) / 2),
    y: 25 + Math.round((875 - 700) / 2),
    width: 1000,
    height: 700,
    maximized: false,
  })

  // 4. Tiny screen smaller than minWidth still fits inside workArea cleanly.
  const tiny = { workArea: { x: 0, y: 0, width: 480, height: 420 } }
  assert.deepEqual(
    resolveRestoredBounds({ x: 10, y: 10, width: 1200, height: 800, maximized: false }, [tiny], { primary: tiny }),
    { x: 0, y: 0, width: 480, height: 420, maximized: false },
  )
})

test('watchWindowBounds ignores hidden startup placement, debounces move/resize, preserves normal bounds across fullscreen, and flushes on close/hide', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-watch-bounds-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'window-bounds.json')

  // Pre-seed saved maximized state to ensure hidden startup placement does not clobber it.
  writeWindowBounds(file, { x: 200, y: 150, width: 1100, height: 720, maximized: true })

  const win = makeFakeWin({ x: 200, y: 150, width: 1100, height: 720 })
  const watcher = watchWindowBounds(win, { file, debounceMs: 25 })
  t.after(() => watcher.dispose())

  // Hidden move/resize before first show must not overwrite saved state.
  win.setRect({ x: 50, y: 50, width: 900, height: 600 })
  win.emit('resize')
  win.emit('move')
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.deepEqual(readWindowBounds(file), { x: 200, y: 150, width: 1100, height: 720, maximized: true })

  // Once shown, user moves/resizes -> debounced write persists.
  win.setVisible(true)
  win.setRect({ x: 240, y: 180, width: 1160, height: 780 })
  win.emit('move')
  win.emit('resize')
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.deepEqual(readWindowBounds(file), { x: 240, y: 180, width: 1160, height: 780, maximized: false })

  // Fullscreen resize does not overwrite normal bounds.
  win.setFullScreen(true)
  win.setRect({ x: 0, y: 0, width: 1920, height: 1080 })
  win.emit('resize')
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.deepEqual(readWindowBounds(file), { x: 240, y: 180, width: 1160, height: 780, maximized: false })

  // Leaving fullscreen, resizing, and maximizing records new normal bounds + maximized: true immediately on hide.
  win.setFullScreen(false)
  win.setRect({ x: 300, y: 190, width: 1150, height: 760 })
  win.emit('move')
  win.emit('resize')
  win.setMaximized(true)
  win.emit('hide')
  assert.deepEqual(readWindowBounds(file), { x: 300, y: 190, width: 1150, height: 760, maximized: true })

  win.destroy()
})

test('watchWindowBounds caches normal/maximized state before minimize within debounce and seeds initial normal rect on maximized platforms', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-watch-race-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'window-bounds.json')

  const initial = { x: 200, y: 150, width: 1100, height: 720, maximized: true }
  writeWindowBounds(file, initial)

  const win = makeFakeWin({ x: 0, y: 0, width: 1920, height: 1040 })
  win.setVisible(true)
  win.setMaximized(true)
  // Simulate Linux/X11 where getNormalBounds() returns maximized workArea while maximized.
  let writeCount = 0
  const watcher = watchWindowBounds(win, { file, debounceMs: 80, initial, onSave: () => { writeCount += 1 } })
  t.after(() => watcher.dispose())

  // Initial maximize/resize matching seeded initial state must not clobber normal bounds or write unnecessarily.
  win.emit('maximize')
  win.emit('resize')
  watcher.flush()
  assert.equal(writeCount, 0, 'matching initial state performs no redundant disk write')
  assert.deepEqual(readWindowBounds(file), initial, 'normal bounds preserved when getNormalBounds reports maximized size')

  // Unmaximize, move/resize to a new normal rect, maximize, then immediately minimize BEFORE debounce fires,
  // with isMaximized() reporting false while minimized (as on Windows/macOS).
  win.setMaximized(false)
  win.setRect({ x: 320, y: 210, width: 1040, height: 680 })
  win.emit('move')
  win.emit('resize')
  win.setMaximized(true)
  win.setRect({ x: 0, y: 0, width: 1920, height: 1040 })
  win.setMinimized(true)
  win.isMaximized = () => false
  win.emit('hide')
  assert.deepEqual(
    readWindowBounds(file),
    { x: 320, y: 210, width: 1040, height: 680, maximized: true },
    'flush after immediate minimize preserves cached normal rect and maximized: true',
  )
  win.destroy()
})

test('minimized start hand-off activates watchWindowBounds on restore and persists subsequent moves', async (t) => {
  const { StartWindow } = await import('../src/start-window.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'dsb-min-handoff-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'window-bounds.json')
  const initial = { x: 100, y: 100, width: 1100, height: 740, maximized: true }
  writeWindowBounds(file, initial)

  const main = makeFakeWin({ x: 100, y: 100, width: 1100, height: 740 })
  main.maximize = () => { main.setMaximized(true) }
  main.minimize = () => { main.setMinimized(true) }
  main.show = () => { main.setVisible(true) }
  main.showInactive = () => { main.setVisible(true) }
  main.hide = () => { main.setVisible(false) }
  main.setBounds = (r) => { main.setRect(r) }
  main.setOpacity = () => {}
  main.setSkipTaskbar = () => {}
  main.flashFrame = () => {}
  main.focus = () => {}

  const startWin = makeFakeWin({ x: 200, y: 200, width: 720, height: 540 })
  startWin.setMinimized(true)
  startWin.isFocused = () => false
  startWin.setContentBounds = () => {}
  startWin.setOpacity = () => {}
  startWin.setSkipTaskbar = () => {}
  startWin.moveTop = () => {}
  startWin.getMediaSourceId = () => 'window:1:0'
  startWin.loadURL = async () => {}
  startWin.webContents = Object.assign(new EventEmitter(), {
    send: () => {},
    setWindowOpenHandler: () => {},
    insertCSS: async () => {},
    reload: () => {},
    mainFrame: {},
  })

  const display = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } }
  let savedReads = 0
  const start = new StartWindow({
    electron: {
      BrowserWindow: class { constructor() { return startWin } },
      ipcMain: { handle: () => {} },
      screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => display, getDisplayMatching: () => display, getPrimaryDisplay: () => display },
      shell: {},
      clipboard: { writeText: () => {} },
      nativeTheme: Object.assign(new EventEmitter(), { shouldUseDarkColors: false }),
      systemPreferences: {},
    },
    page: '/tmp/start.html',
    preload: '/tmp/preload.cjs',
    icon: '/tmp/icon.png',
    devTools: false,
    lang: () => 'en',
    motion: 'normal',
    effects: 'off',
    version: '0.4.1',
    program: [],
    log: { dir: '/tmp', tail: () => [] },
    mainWindow: () => main,
    savedBounds: () => { savedReads += 1; return initial },
    onRetry: () => {},
    onReload: () => {},
    onClose: () => {},
  })

  const watcher = watchWindowBounds(main, { file, debounceMs: 25, initial, ready: () => start.boundsReady })
  t.after(() => watcher.dispose())

  start.open('later')
  start.done('data')
  start.done('engine')
  start.ready()
  await start.teamShown
  assert.equal(main.isMinimized(), true, 'hand-off keeps the team window minimized')
  assert.equal(main.isMaximized(), false, 'does not maximize while minimized')
  assert.equal(savedReads, 1, 'savedBounds is snapshotted once for the startup lifecycle')

  // Restoring from Dock/taskbar emits restore (without show).
  main.setMinimized(false)
  main.emit('restore')
  assert.equal(main.isMaximized(), true, 'restoring applies the deferred maximized state')
  assert.equal(start.boundsReady, true, 'boundsReady activates once restore finishes')

  // Subsequent unmaximize + move/resize + hide must persist to disk.
  main.setMaximized(false)
  main.setRect({ x: 260, y: 170, width: 1020, height: 690 })
  main.emit('move')
  main.emit('resize')
  main.emit('hide')
  assert.deepEqual(readWindowBounds(file), { x: 260, y: 170, width: 1020, height: 690, maximized: false })

  startWin.destroy()
  main.destroy()
})

test('focused maximized hand-off maximizes before reveal without intermediate clobber, behind defers until focus, and start window opens on restored display', async (t) => {
  const { StartWindow } = await import('../src/start-window.mjs')
  const primary = { workArea: { x: 0, y: 0, width: 1440, height: 900 } }
  const secondary = { workArea: { x: 1440, y: 0, width: 1920, height: 1080 } }

  const runHandOff = async ({ focused, effects = 'full' }) => {
    const dir = mkdtempSync(join(tmpdir(), 'dsb-handoff-mode-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const file = join(dir, 'window-bounds.json')
    const initial = { x: 1600, y: 100, width: 1200, height: 800, maximized: true }
    writeWindowBounds(file, initial)

    const order = []
    let startOpts
    const main = makeFakeWin({ x: 1600, y: 100, width: 1200, height: 800 })
    main.maximize = () => { order.push('maximize'); main.setMaximized(true) }
    main.minimize = () => { main.setMinimized(true) }
    main.show = () => { order.push('show'); main.setVisible(true) }
    main.showInactive = () => { order.push('showInactive'); main.setVisible(true) }
    main.hide = () => { main.setVisible(false) }
    main.setBounds = (r) => { main.setRect(r) }
    main.setOpacity = (v) => { if (v === 1) order.push('opaque') }
    main.setSkipTaskbar = () => {}
    main.flashFrame = () => {}
    main.focus = () => { order.push('focus') }
    main.moveAbove = () => { order.push('moveAbove') }

    const startWin = makeFakeWin({ x: 1600, y: 100, width: 720, height: 540 })
    startWin.isFocused = () => focused
    startWin.setContentBounds = () => {}
    startWin.setOpacity = () => {}
    startWin.setSkipTaskbar = () => {}
    startWin.moveTop = () => {}
    startWin.getMediaSourceId = () => 'window:1:0'
    startWin.loadURL = async () => {}
    startWin.webContents = Object.assign(new EventEmitter(), {
      send: () => {},
      setWindowOpenHandler: () => {},
      insertCSS: async () => {},
      reload: () => {},
      mainFrame: {},
    })

    let reads = 0
    const start = new StartWindow({
      electron: {
        BrowserWindow: class { constructor(opts) { startOpts = opts; return startWin } },
        ipcMain: { handle: () => {} },
        screen: {
          getCursorScreenPoint: () => ({ x: 100, y: 100 }),
          getDisplayNearestPoint: () => primary,
          getDisplayMatching: (r) => (r.x >= 1440 ? secondary : primary),
          getPrimaryDisplay: () => primary,
        },
        shell: {},
        clipboard: { writeText: () => {} },
        nativeTheme: Object.assign(new EventEmitter(), { shouldUseDarkColors: false }),
        systemPreferences: {},
      },
      page: '/tmp/start.html',
      preload: '/tmp/preload.cjs',
      icon: '/tmp/icon.png',
      devTools: false,
      lang: () => 'en',
      motion: 'normal',
      effects,
      version: '0.4.1',
      program: [],
      log: { dir: '/tmp', tail: () => [] },
      mainWindow: () => main,
      savedBounds: () => { reads += 1; return initial },
      onRetry: () => {},
      onReload: () => {},
      onClose: () => {},
    })

    const watcher = watchWindowBounds(main, { file, debounceMs: 10, initial, ready: () => start.boundsReady })
    t.after(() => watcher.dispose())

    start.open('later')
    start.done('data')
    start.done('engine')
    start.ready()
    await start.teamShown
    // Simulate a WM resize event right after reveal starts during crossfade.
    main.emit('resize')
    await new Promise(resolve => setTimeout(resolve, 260))
    return { start, main, startWin, startOpts, order, file, reads, initial }
  }

  // Focused startup: opens start window on secondary display, maximizes BEFORE fading opaque, never clobbers file.
  const focusedRun = await runHandOff({ focused: true, effects: 'full' })
  assert.ok(focusedRun.startOpts.x >= 1440, 'start window opens on the restored display (secondary)')
  assert.equal(focusedRun.reads, 1, 'savedBounds read once during startup')
  assert.equal(focusedRun.main.isMaximized(), true)
  assert.equal(focusedRun.start.boundsReady, true)
  assert.ok(focusedRun.order.indexOf('maximize') < focusedRun.order.indexOf('opaque'), 'maximizes before crossfade finishes so there is no post-fade jump')
  assert.deepEqual(readWindowBounds(focusedRun.file), focusedRun.initial)
  focusedRun.startWin.destroy()
  focusedRun.main.destroy()

  // Behind startup: does NOT call maximize while behind (no focus theft / z-order disruption); applies maximize on focus.
  const behindRun = await runHandOff({ focused: false, effects: 'off' })
  assert.equal(behindRun.main.isMaximized(), false, 'behind hand-off does not maximize while unfocused')
  assert.equal(behindRun.start.boundsReady, false, 'boundsReady waits until deferred maximize completes')
  behindRun.main.emit('focus')
  assert.equal(behindRun.main.isMaximized(), true, 'focus applies deferred maximized state')
  assert.equal(behindRun.start.boundsReady, true)
  behindRun.startWin.destroy()
  behindRun.main.destroy()
})
