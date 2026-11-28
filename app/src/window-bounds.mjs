// Persists and restores the main window's size, position, and maximized state in Electron's
// userData directory (never in DSH_HOME). Clamps restored bounds onto available displays so
// unplugging or resizing a monitor never leaves the window off-screen.
//
// Platform note: under native Wayland on Linux, Electron/Chromium cannot read or set global
// window (x, y) coordinates; size and maximized state still restore where the compositor allows.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const WINDOW_BOUNDS_FILE = 'window-bounds.json'
export const MIN_WINDOW_SIZE = Object.freeze({ width: 508, height: 480 })

const APP_TITLE = 'DS Bot'
const TITLE_SUFFIX = ` — ${APP_TITLE}`
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u

export function isAllowedWindowTitle(title) {
  if (typeof title !== 'string' || CONTROL_CHARS.test(title)) return false
  if (title === APP_TITLE) return true
  if (!title.endsWith(TITLE_SUFFIX)) return false
  return title.slice(0, -TITLE_SUFFIX.length).trim() !== ''
}

function validRect(rect, { minWidth = MIN_WINDOW_SIZE.width, minHeight = MIN_WINDOW_SIZE.height } = {}) {
  if (rect === null || typeof rect !== 'object') return undefined
  const x = Math.round(Number(rect.x))
  const y = Math.round(Number(rect.y))
  const width = Math.round(Number(rect.width))
  const height = Math.round(Number(rect.height))
  if (![x, y, width, height].every(Number.isFinite)) return undefined
  if (width < minWidth || height < minHeight) return undefined
  return { x, y, width, height }
}

/** @returns {{ x: number, y: number, width: number, height: number, maximized: boolean } | undefined} */
export function readWindowBounds(file) {
  let saved
  try {
    saved = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
  const rect = validRect(saved)
  if (rect === undefined) return undefined
  return { ...rect, maximized: saved?.maximized === true }
}

/** Writes valid window bounds atomically; returns whether the write succeeded. */
export function writeWindowBounds(file, bounds) {
  const rect = validRect(bounds)
  if (rect === undefined) return false
  const payload = { ...rect, maximized: bounds?.maximized === true }
  const tmpFile = `${file}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmpFile, `${JSON.stringify(payload)}\n`)
    renameSync(tmpFile, file)
    return true
  } catch (error) {
    console.error('DS Bot: window bounds were not saved:', error)
    return false
  }
}

function areaOf(entry) {
  const area = entry?.workArea ?? entry
  if (area === null || typeof area !== 'object') return undefined
  const [x, y, width, height] = [area.x, area.y, area.width, area.height].map(Number)
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return undefined
  return { x, y, width, height }
}

function overlapArea(a, b) {
  const overlapW = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const overlapH = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  if (overlapW <= 0 || overlapH <= 0) return { overlapW: 0, overlapH: 0, area: 0 }
  return { overlapW, overlapH, area: overlapW * overlapH }
}

/**
 * Resolves saved bounds against the currently attached displays.
 * If the saved rect overlaps a connected display meaningfully, it stays on that display
 * (shrunk and shifted inside workArea if needed). Otherwise (e.g. unplugged monitor), it is
 * centered on the primary display with size clamped to that workArea.
 */
export function resolveRestoredBounds(saved, displays, { minWidth = MIN_WINDOW_SIZE.width, minHeight = MIN_WINDOW_SIZE.height, primary } = {}) {
  const rect = validRect(saved, { minWidth: 1, minHeight: 1 })
  if (rect === undefined) return undefined
  const areas = (Array.isArray(displays) ? displays : []).map(areaOf).filter(Boolean)
  const primaryArea = areaOf(primary) ?? areas[0]
  if (primaryArea === undefined) return undefined

  const minVisibleW = Math.min(100, rect.width)
  const minVisibleH = Math.min(60, rect.height)
  let targetArea
  let bestOverlap = 0
  for (const area of areas) {
    const { overlapW, overlapH, area: px } = overlapArea(rect, area)
    if (overlapW >= Math.min(minVisibleW, area.width) && overlapH >= Math.min(minVisibleH, area.height) && px > bestOverlap) {
      bestOverlap = px
      targetArea = area
    }
  }

  const area = targetArea ?? primaryArea
  const width = Math.min(Math.max(rect.width, Math.min(minWidth, area.width)), area.width)
  const height = Math.min(Math.max(rect.height, Math.min(minHeight, area.height)), area.height)

  const x = targetArea
    ? Math.min(Math.max(rect.x, area.x), area.x + area.width - width)
    : area.x + Math.round((area.width - width) / 2)
  const y = targetArea
    ? Math.min(Math.max(rect.y, area.y), area.y + area.height - height)
    : area.y + Math.round((area.height - height) / 2)

  return { x, y, width, height, maximized: saved?.maximized === true }
}

/**
 * Tracks a BrowserWindow's normal bounds and maximized state after it has been shown or restored,
 * debouncing move/resize writes and flushing synchronously on close/hide/quit.
 */
export function watchWindowBounds(win, { file, debounceMs = 250, ready = () => true, initial, onSave } = {}) {
  const initialRect = validRect(initial)
  let shownOnce = Boolean(win.isVisible?.())
  let dirty = false
  let timer
  let lastNormal = initialRect ?? null
  let lastMaximized = initialRect ? initial?.maximized === true : Boolean(win.isMaximized?.())
  let lastSavedJson = initialRect ? JSON.stringify({ ...initialRect, maximized: lastMaximized }) : ''

  const active = () => !win.isDestroyed?.() && shownOnce && ready() === true

  const capture = () => {
    if (!active()) return undefined
    if (win.isMinimized?.() || win.isFullScreen?.()) return undefined
    const maximized = Boolean(win.isMaximized?.())
    lastMaximized = maximized
    if (!maximized || lastNormal === null) {
      const raw = typeof win.getNormalBounds === 'function' ? win.getNormalBounds() : win.getBounds?.()
      const rect = validRect(raw)
      if (rect !== undefined) lastNormal = rect
    }
    return lastNormal ? { ...lastNormal, maximized: lastMaximized } : undefined
  }

  const flush = () => {
    clearTimeout(timer)
    timer = undefined
    if (!dirty) return false
    const next = capture() ?? (active() && lastNormal ? { ...lastNormal, maximized: lastMaximized } : undefined)
    if (next === undefined) return false
    const serialized = JSON.stringify(next)
    dirty = false
    if (serialized === lastSavedJson) return false
    if (writeWindowBounds(file, next)) {
      lastSavedJson = serialized
      onSave?.(next)
      return true
    }
    return false
  }

  const schedule = () => {
    if (!active() || win.isMinimized?.() || win.isFullScreen?.()) return
    capture()
    dirty = true
    clearTimeout(timer)
    timer = setTimeout(flush, debounceMs)
    timer.unref?.()
  }

  const onShow = () => { shownOnce = true }
  const onChange = () => { schedule() }
  const onFlush = () => { flush() }

  const dispose = () => {
    clearTimeout(timer)
    timer = undefined
    win.off?.('show', onShow)
    win.off?.('restore', onShow)
    win.off?.('move', onChange)
    win.off?.('resize', onChange)
    win.off?.('maximize', onChange)
    win.off?.('unmaximize', onChange)
    win.off?.('hide', onFlush)
    win.off?.('close', onFlush)
    win.off?.('closed', dispose)
  }

  win.on('show', onShow)
  win.on('restore', onShow)
  win.on('move', onChange)
  win.on('resize', onChange)
  win.on('maximize', onChange)
  win.on('unmaximize', onChange)
  win.on('hide', onFlush)
  win.on('close', onFlush)
  win.once('closed', dispose)

  return { flush, dispose }
}
