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

  // Leaving fullscreen and maximizing records maximized: true immediately on close/hide.
  win.setFullScreen(false)
  win.setRect({ x: 300, y: 190, width: 1150, height: 760 })
  win.setMaximized(true)
  win.emit('hide')
  assert.deepEqual(readWindowBounds(file), { x: 300, y: 190, width: 1150, height: 760, maximized: true })

  win.destroy()
})
