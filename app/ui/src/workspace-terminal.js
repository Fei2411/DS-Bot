// Interactive direct-input workspace terminal for the desktop right panel.
// Mounts a persistent @xterm/xterm + @xterm/addon-fit instance per terminal tab,
// streams live PTY chunks over local `api/bot/feed`, syncs dynamic DS Bot themes,
// and talks to ds-bot host `terminal-*` endpoints.
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import { call } from '../../../ds-bot/src/client/api.js'
import { hostText, t } from '../../../ds-bot/src/client/i18n.js'
import { CloseIcon, PlusIcon, TerminalIcon } from '../../../ds-bot/src/client/icons.js'
import { matchShortcutEvent } from '../../../ds-bot/src/client/shortcuts-model.js'
import { writeClipboard } from './primitives.js'
import { getLiveShortcutContext } from './shortcuts.js'

const MAX_CLIENT_BUFFER = 64 * 1024
const MAX_PENDING_EVENT_IDS = 16
const MAX_LOCAL_HISTORY = 50
const ESC_CODE = 0x1b
const BEL_CODE = 0x07
const DEFAULT_MONO_FONT = 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace'

const FG_CODES = new Map([
  [30, 'gray'], [31, 'red'], [32, 'green'], [33, 'yellow'], [34, 'blue'], [35, 'magenta'], [36, 'cyan'], [37, 'ink'],
  [90, 'gray'], [91, 'red'], [92, 'green'], [93, 'yellow'], [94, 'blue'], [95, 'magenta'], [96, 'cyan'], [97, 'ink'],
])

function shortCwd(cwd, fallback) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return fallback || ''
  const parts = cwd.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 2) return cwd
  return `…/${parts.slice(-2).join('/')}`
}

/**
 * Parses ANSI escape sequences and terminal cursor edits into styled text spans.
 * Kept exported for backwards compatibility with callers and tests.
 * @param {string} raw
 * @returns {Array<{ text: string, fg?: string, bold?: boolean, dim?: boolean }>}
 */
export function parseAnsiSpans(raw) {
  const src = String(raw ?? '')
  if (src === '') return []
  const lines = []
  let line = []
  let col = 0
  let fg
  let bold = false
  let dim = false

  const finishLine = () => {
    while (line.length > col) {
      const tail = line[line.length - 1]
      if (tail.ch !== ' ' || tail.fg || tail.bold || tail.dim) break
      line.pop()
    }
    lines.push(line)
    line = []
    col = 0
  }

  const putChar = (ch) => {
    while (line.length < col) line.push({ ch: ' ' })
    line[col] = { ch, ...(fg ? { fg } : {}), ...(bold ? { bold: true } : {}), ...(dim ? { dim: true } : {}) }
    col += 1
  }

  for (let i = 0; i < src.length; i += 1) {
    const code = src.charCodeAt(i)
    if (code === 0x0d) {
      if (src.charCodeAt(i + 1) === 0x0a) {
        i += 1
        finishLine()
      } else {
        col = 0
      }
      continue
    }
    if (code === 0x0a) {
      finishLine()
      continue
    }
    if (code === 0x08) {
      col = Math.max(0, col - 1)
      continue
    }
    if (code === ESC_CODE) {
      const next = src[i + 1]
      if (next === '[') {
        let j = i + 2
        while (j < src.length && ((src.charCodeAt(j) >= 0x30 && src.charCodeAt(j) <= 0x3f) || (src.charCodeAt(j) >= 0x20 && src.charCodeAt(j) <= 0x2f))) {
          j += 1
        }
        const params = src.slice(i + 2, j)
        const finalByte = j < src.length ? src[j] : ''
        i = j < src.length ? j : src.length - 1
        if (finalByte === 'm') {
          const codes = (params === '' ? '0' : params).split(';').map(n => Number.parseInt(n, 10))
          for (let k = 0; k < codes.length; k += 1) {
            const sgr = codes[k]
            if (Number.isNaN(sgr) || sgr === 0) {
              fg = undefined
              bold = false
              dim = false
            } else if (sgr === 38 || sgr === 48) {
              const mode = codes[k + 1]
              if (mode === 5) k += 2
              else if (mode === 2) k += 4
            } else if (sgr === 1) {
              bold = true
            } else if (sgr === 2) {
              dim = true
            } else if (sgr === 22) {
              bold = false
              dim = false
            } else if (sgr === 39) {
              fg = undefined
            } else if (FG_CODES.has(sgr)) {
              fg = FG_CODES.get(sgr)
            }
          }
        } else if (finalByte === 'K') {
          const mode = params === '' ? 0 : Number.parseInt(params.split(';')[0], 10)
          if (Number.isNaN(mode) || mode === 0) {
            if (col < line.length) line.length = col
          } else if (mode === 1) {
            for (let k = 0; k <= Math.min(col, line.length - 1); k += 1) line[k] = { ch: ' ' }
          } else if (mode === 2) {
            line.length = 0
          }
        } else if (finalByte === 'J') {
          const mode = params === '' ? 0 : Number.parseInt(params.split(';')[0], 10)
          if (Number.isNaN(mode) || mode === 0) {
            if (col < line.length) line.length = col
          } else if (mode === 2 || mode === 3) {
            lines.length = 0
            line = []
            col = 0
          }
        } else if (finalByte === 'D') {
          const n = Math.max(1, Number.parseInt(params, 10) || 1)
          col = Math.max(0, col - n)
        } else if (finalByte === 'C') {
          const n = Math.max(1, Number.parseInt(params, 10) || 1)
          col += n
        } else if (finalByte === 'G') {
          const n = Math.max(1, Number.parseInt(params, 10) || 1)
          col = n - 1
        } else if (finalByte === 'P') {
          const n = Math.max(1, Number.parseInt(params, 10) || 1)
          if (col < line.length) line.splice(col, n)
        } else if (finalByte === '@') {
          const n = Math.max(1, Number.parseInt(params, 10) || 1)
          while (line.length < col) line.push({ ch: ' ' })
          line.splice(col, 0, ...Array.from({ length: n }, () => ({ ch: ' ' })))
        }
        continue
      }
      if (next === ']') {
        let j = i + 2
        while (j < src.length) {
          const c = src.charCodeAt(j)
          if (c === BEL_CODE) { i = j; break }
          if (c === ESC_CODE && src[j + 1] === '\\') { i = j + 1; break }
          j += 1
        }
        if (j >= src.length) i = src.length - 1
        continue
      }
      if (next === '(' || next === ')' || next === '#') {
        i = Math.min(src.length - 1, i + 2)
        continue
      }
      i = Math.min(src.length - 1, i + 1)
      continue
    }
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) continue
    putChar(src[i])
  }
  finishLine()

  const spans = []
  const pushCell = (ch, cellFg, cellBold, cellDim) => {
    const last = spans[spans.length - 1]
    if (last && last.fg === cellFg && Boolean(last.bold) === Boolean(cellBold) && Boolean(last.dim) === Boolean(cellDim)) {
      last.text += ch
    } else {
      spans.push({
        text: ch,
        ...(cellFg ? { fg: cellFg } : {}),
        ...(cellBold ? { bold: true } : {}),
        ...(cellDim ? { dim: true } : {}),
      })
    }
  }
  for (let li = 0; li < lines.length; li += 1) {
    if (li > 0) pushCell('\n', undefined, false, false)
    for (const cell of lines[li]) {
      pushCell(cell.ch, cell.fg, cell.bold, cell.dim)
    }
  }
  return spans
}

const trimTail = text => (text.length > MAX_CLIENT_BUFFER ? text.slice(text.length - MAX_CLIENT_BUFFER) : text)

const trimmedOutputMarker = () => `\r\n\x1b[2m[${t('Earlier output was trimmed')}]\x1b[0m\r\n`

const isMacPlatform = () => (typeof navigator !== 'undefined'
  && /mac|iphone|ipad|ipod/i.test(navigator.userAgentData?.platform ?? navigator.platform ?? navigator.userAgent ?? ''))

/**
 * Resolves concrete RGB/hex colors from DS Bot's CSS custom properties for xterm.js.
 * Uses a single temporary hidden probe element so `var(...)` and `color-mix(...)` tokens
 * evaluate accurately in Light, Dark, and custom Accent themes.
 */
export function readXtermTheme() {
  const dark = Boolean(typeof document !== 'undefined' && document.body?.hasAttribute?.('data-ds-dark-theme'))
  let fontFamily = DEFAULT_MONO_FONT
  let resolve = (_expr, fallback) => fallback
  let probe = null
  try {
    if (typeof document !== 'undefined' && document.body && typeof document.createElement === 'function' && typeof getComputedStyle === 'function') {
      const bodyStyle = getComputedStyle(document.body)
      const mono = bodyStyle.getPropertyValue('--bt-mono').trim()
      if (mono) fontFamily = mono
      probe = document.createElement('span')
      probe.style.display = 'none'
      document.body.appendChild(probe)
      resolve = (expr, fallback) => {
        probe.style.color = ''
        probe.style.color = expr
        const value = getComputedStyle(probe).color
        return value && value !== '' ? value : fallback
      }
    }
    const background = resolve('var(--bt-sidebar)', dark ? '#181818' : '#f7f7f7')
    const foreground = resolve('var(--bt-ink)', dark ? '#f0f0f0' : '#141414')
    const muted = resolve('var(--bt-ink-3)', dark ? '#737373' : '#71717a')
    const accent = resolve('var(--bt-accent)', '#4d6bfe')
    const danger = resolve('var(--bt-danger)', dark ? '#ff6b72' : '#e02135')
    const green = resolve(dark ? 'var(--bt-green)' : 'color-mix(in srgb, var(--bt-green) 80%, var(--bt-ink))', dark ? '#00c972' : '#15803d')
    const brightGreen = resolve('var(--bt-green)', '#00c972')
    const yellow = resolve(dark ? 'var(--bt-star)' : 'color-mix(in srgb, var(--bt-star) 78%, var(--bt-ink))', dark ? '#ff9800' : '#a16207')
    const brightYellow = resolve('var(--bt-star)', '#ff9800')
    const magenta = resolve('color-mix(in srgb, var(--bt-accent) 62%, var(--bt-danger))', dark ? '#c084fc' : '#9333ea')
    const brightMagenta = resolve('color-mix(in srgb, var(--bt-accent) 52%, var(--bt-danger))', dark ? '#d8b4fe' : '#a855f7')
    const selectionBackground = resolve('color-mix(in srgb, var(--bt-accent) 26%, transparent)', 'rgba(77, 107, 254, 0.26)')
    const selectionInactiveBackground = resolve('var(--bt-hover)', 'rgba(128, 128, 128, 0.16)')
    return {
      fontFamily,
      theme: {
        background,
        foreground,
        cursor: accent,
        cursorAccent: background,
        selectionBackground,
        selectionInactiveBackground,
        black: dark ? '#27272a' : '#141414',
        brightBlack: muted,
        red: danger,
        brightRed: danger,
        green,
        brightGreen,
        yellow,
        brightYellow,
        blue: accent,
        brightBlue: accent,
        magenta,
        brightMagenta,
        cyan: dark ? '#38bdf8' : '#0284c7',
        brightCyan: dark ? '#7dd3fc' : '#0369a1',
        white: dark ? '#d4d4d8' : '#52525b',
        brightWhite: foreground,
      },
    }
  } finally {
    probe?.remove?.()
  }
}

/**
 * Builds the custom xterm key handler so Cmd+C / Ctrl+Shift+C copy when text is selected,
 * Cmd+V / Ctrl+Shift+V paste natively, active global app shortcuts bubble cleanly to window,
 * and terminal control keys (`Ctrl+C`, `Ctrl+D`, `Ctrl+L`, arrows, Tab, Esc, etc.) flow to the PTY.
 */
export function createTerminalKeyHandler(term, { mac = isMacPlatform(), copy = writeClipboard, overrides, getContext = getLiveShortcutContext } = {}) {
  return (event) => {
    if (!event || event.type !== 'keydown') return true
    const key = String(event.key ?? '').toLowerCase()
    const code = String(event.code ?? '')
    if (mac && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      if (key === 'c' || code === 'KeyC') {
        if (term.hasSelection?.()) {
          const selected = term.getSelection?.() ?? ''
          if (selected) void copy(selected)
          term.clearSelection?.()
          event.preventDefault?.()
        }
        return false
      }
      if (key === 'v' || code === 'KeyV') return false
    }
    if (!mac && event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey) {
      if ((key === 'c' || code === 'KeyC') && term.hasSelection?.()) {
        const selected = term.getSelection?.() ?? ''
        if (selected) void copy(selected)
        term.clearSelection?.()
        event.preventDefault?.()
        return false
      }
      if (key === 'v' || code === 'KeyV') return false
    }
    // Let active global shortcuts (including custom bindings, F1–F12, and allowInTerminal
    // commands like Ctrl+`) bubble to the window dispatcher using the same live mode,
    // capabilities, and modal state as the window listener; plain non-Mac Ctrl+<key>
    // terminal control sequences return null and continue straight to the PTY.
    const live = typeof getContext === 'function' ? (getContext() ?? {}) : {}
    if (matchShortcutEvent(event, { ...live, mac, inTerminal: true, ...(overrides !== undefined ? { overrides } : {}) })) {
      return false
    }
    return true
  }
}

/**
 * Local direct-on-canvas line editor for rare non-PTY pipe-backed fallback shells.
 */
export function createLocalLineEditor(term, onLine, onEof) {
  let line = ''
  const history = []
  let historyIdx = -1

  const replaceLine = (next) => {
    if (line.length > 0) term.write('\b \b'.repeat(line.length))
    line = next
    if (line.length > 0) term.write(line)
  }

  return (data) => {
    if (typeof data !== 'string' || data === '') return
    const recallPrev = () => {
      if (history.length === 0) return
      historyIdx = Math.min(historyIdx + 1, history.length - 1)
      replaceLine(history[historyIdx] ?? '')
    }
    const recallNext = () => {
      if (historyIdx < 0) return
      historyIdx -= 1
      replaceLine(historyIdx < 0 ? '' : (history[historyIdx] ?? ''))
    }

    for (let i = 0; i < data.length; i += 1) {
      const ch = data[i]
      const code = ch.charCodeAt(0)
      if (ch === '\x1b') {
        if (data[i + 1] === '[') {
          let end = i + 2
          while (end < data.length && (data.charCodeAt(end) < 0x40 || data.charCodeAt(end) > 0x7e)) end += 1
          const seq = data.slice(i, end + 1)
          if (seq === '\x1b[A') recallPrev()
          else if (seq === '\x1b[B') recallNext()
          i = Math.min(end, data.length - 1)
        } else if (data[i + 1] === 'O' && i + 2 < data.length) {
          if (data[i + 2] === 'A') recallPrev()
          else if (data[i + 2] === 'B') recallNext()
          i += 2
        } else if (i + 1 < data.length) {
          i += 1
        }
        continue
      }
      if (ch === '\x03') {
        term.write('^C\r\n')
        line = ''
        historyIdx = -1
      } else if (ch === '\x04') {
        if (line === '') onEof?.()
      } else if (ch === '\x0c') {
        term.clear?.()
      } else if (ch === '\x15') {
        replaceLine('')
        historyIdx = -1
      } else if (ch === '\r' || ch === '\n') {
        if (ch === '\r' && data[i + 1] === '\n') i += 1
        term.write('\r\n')
        const submitted = line
        line = ''
        historyIdx = -1
        if (submitted.trim() !== '') {
          history.unshift(submitted)
          if (history.length > MAX_LOCAL_HISTORY) history.length = MAX_LOCAL_HISTORY
        }
        onLine(`${submitted}\n`)
      } else if (code === 0x7f || code === 0x08) {
        if (line.length > 0) {
          line = line.slice(0, -1)
          term.write('\b \b')
        }
      } else if (code >= 0x20 || ch === '\t') {
        line += ch
        term.write(ch)
      }
    }
  }
}

function TerminalPane({
  term,
  active,
  readOnly,
  writersRef,
  pendingOutputRef,
  onSendInput,
  onResize,
}) {
  const paneRef = useRef(null)
  const hostRef = useRef(null)
  const activeRef = useRef(active)
  activeRef.current = active
  const exitedRef = useRef(term.exited)
  exitedRef.current = term.exited
  const readOnlyRef = useRef(readOnly)
  readOnlyRef.current = readOnly
  const ptyRef = useRef(term.pty !== false)
  ptyRef.current = term.pty !== false
  const sendInputRef = useRef(onSendInput)
  sendInputRef.current = onSendInput
  const resizeRef = useRef(onResize)
  resizeRef.current = onResize
  const initialSnapshotRef = useRef(term.initialSnapshot ?? '')

  useEffect(() => {
    const hostEl = hostRef.current
    if (!hostEl) return undefined

    let disposed = false
    let fitRaf = 0
    const lastSize = { cols: 0, rows: 0 }
    const { theme, fontFamily } = readXtermTheme()
    const xterm = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontSize: 12.5,
      lineHeight: 1.4,
      fontFamily,
      scrollback: 5000,
      convertEol: !ptyRef.current,
      theme,
    })
    const fitAddon = new FitAddon()
    xterm.loadAddon(fitAddon)
    xterm.open(hostEl)
    xterm.attachCustomKeyEventHandler(createTerminalKeyHandler(xterm))

    const lineEditor = ptyRef.current
      ? null
      : createLocalLineEditor(
        xterm,
        line => { if (!exitedRef.current && !readOnlyRef.current) void sendInputRef.current(term.id, line) },
        () => { if (!exitedRef.current && !readOnlyRef.current) void sendInputRef.current(term.id, '\x04') },
      )

    const dataSub = xterm.onData((data) => {
      if (disposed || exitedRef.current || readOnlyRef.current) return
      if (ptyRef.current) {
        void sendInputRef.current(term.id, data)
      } else {
        lineEditor?.(data)
      }
    })

    const runFit = () => {
      fitRaf = 0
      if (disposed || !activeRef.current) return
      const box = paneRef.current ?? hostEl
      if ((box.offsetWidth ?? 0) <= 0 || (box.offsetHeight ?? 0) <= 0) return
      try {
        fitAddon.fit()
      } catch {
        return
      }
      const cols = xterm.cols ?? 0
      const rows = xterm.rows ?? 0
      if (cols >= 20 && rows >= 6 && (cols !== lastSize.cols || rows !== lastSize.rows)) {
        lastSize.cols = cols
        lastSize.rows = rows
        if (ptyRef.current && !exitedRef.current && !readOnlyRef.current) {
          void resizeRef.current(term.id, cols, rows)
        }
      }
    }

    const scheduleFit = () => {
      if (disposed) return
      if (typeof requestAnimationFrame === 'function') {
        if (fitRaf) cancelAnimationFrame(fitRaf)
        fitRaf = requestAnimationFrame(runFit)
      } else {
        runFit()
      }
    }

    const disposeInstance = () => {
      if (disposed) return
      disposed = true
      if (fitRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(fitRaf)
      fitRaf = 0
      dataSub?.dispose?.()
      fitAddon.dispose?.()
      xterm.dispose?.()
    }

    const api = {
      write: chunk => { if (!disposed && chunk) xterm.write(chunk) },
      clear: () => { if (!disposed) xterm.clear() },
      focus: () => { if (!disposed) xterm.focus() },
      fit: scheduleFit,
      applyTheme: (nextTheme, nextFont) => {
        if (disposed) return
        if (xterm.options) {
          const prevFont = xterm.options.fontFamily
          xterm.options.theme = nextTheme
          if (nextFont) xterm.options.fontFamily = nextFont
          if (nextFont && prevFont !== nextFont) scheduleFit()
        }
      },
      dispose: disposeInstance,
    }
    writersRef.current.set(term.id, api)

    const queued = pendingOutputRef.current.get(term.id) ?? ''
    pendingOutputRef.current.delete(term.id)
    const initial = `${initialSnapshotRef.current}${queued}`
    initialSnapshotRef.current = ''
    if (initial) xterm.write(initial)

    let resizeObserver = null
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(scheduleFit)
      resizeObserver.observe(hostEl)
    }
    const onWinResize = () => scheduleFit()
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('resize', onWinResize)
    }

    if (activeRef.current) {
      scheduleFit()
      xterm.focus()
    }

    return () => {
      resizeObserver?.disconnect?.()
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('resize', onWinResize)
      }
      if (writersRef.current.get(term.id) === api) writersRef.current.delete(term.id)
      disposeInstance()
    }
  }, [term.id, writersRef, pendingOutputRef])

  useEffect(() => {
    if (!active) return
    const api = writersRef.current.get(term.id)
    if (!api) return
    api.fit()
    api.focus()
  }, [active, term.id, writersRef])

  return h('div', {
    ref: paneRef,
    className: 'dsb-term-pane',
    'data-term-id': term.id,
    hidden: !active,
    onMouseDown: (event) => {
      if (event.target === paneRef.current || event.target === hostRef.current) {
        writersRef.current.get(term.id)?.focus()
      }
    },
  }, h('div', { ref: hostRef, className: 'dsb-term-host' }))
}

/**
 * Interactive local terminal tabs bound to the active Bot/room workspace folder.
 */
export function WorkspaceTerminal({ sessionId, feed, readOnly = false, autoOpenNonce = 0 }) {
  const [state, setState] = useState({ terms: [], activeId: null })
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState('')
  const tabsRef = useRef(null)
  const mountedRef = useRef(true)
  const lastAutoNonceRef = useRef(0)
  const openedOnceRef = useRef(false)
  const openNewRef = useRef(null)
  const autoOpenNonceRef = useRef(autoOpenNonce)
  autoOpenNonceRef.current = autoOpenNonce
  // Persistent xterm writers, early-output buffer, exit stash, known ids, and synchronous closed-id guard.
  const writersRef = useRef(new Map())
  const pendingOutputRef = useRef(new Map())
  const pendingExitRef = useRef(new Map())
  const knownIdsRef = useRef(new Set())
  const closedIdsRef = useRef(new Set())
  const positionsRef = useRef(new Map())
  const syncRunningRef = useRef(false)
  const syncAgainRef = useRef(false)
  const syncPromiseRef = useRef(null)
  const syncRef = useRef(null)
  const { terms, activeId } = state

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // Keep every live xterm instance synced with DS Bot's theme, dark mode, accent, and code font.
  useEffect(() => {
    if (typeof MutationObserver !== 'function' || typeof document === 'undefined') return undefined
    let raf = 0
    const sync = () => {
      raf = 0
      if (writersRef.current.size === 0) return
      const { theme, fontFamily } = readXtermTheme()
      for (const api of writersRef.current.values()) {
        api.applyTheme(theme, fontFamily)
      }
    }
    const schedule = () => {
      if (typeof requestAnimationFrame === 'function') {
        if (raf) cancelAnimationFrame(raf)
        raf = requestAnimationFrame(sync)
      } else {
        sync()
      }
    }
    const observer = new MutationObserver(schedule)
    if (document.documentElement) observer.observe(document.documentElement, { attributes: true })
    if (document.body) observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'class', 'style'] })
    if (document.head) observer.observe(document.head, { childList: true, subtree: true, characterData: true })
    return () => {
      observer.disconnect()
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf)
    }
  }, [])

  // Translate vertical mouse-wheel scrolling into smooth horizontal scrolling on `.dsb-term-tabs`.
  useEffect(() => {
    const box = tabsRef.current
    if (!box || typeof box.addEventListener !== 'function') return undefined
    const onWheel = (event) => {
      if (box.scrollWidth <= box.clientWidth) return
      if (event.deltaY === 0 || Math.abs(event.deltaY) < Math.abs(event.deltaX)) return
      const dy = event.deltaMode === 1
        ? event.deltaY * 24
        : event.deltaMode === 2
          ? event.deltaY * box.clientWidth
          : event.deltaY
      event.preventDefault()
      box.scrollLeft += dy
    }
    box.addEventListener('wheel', onWheel, { passive: false })
    return () => box.removeEventListener('wheel', onWheel)
  }, [])

  const writeOutput = useCallback((id, chunk) => {
    if (!chunk || closedIdsRef.current.has(id)) return
    const writer = writersRef.current.get(id)
    if (writer) writer.write(chunk)
    else {
      const map = pendingOutputRef.current
      if (!map.has(id) && map.size >= MAX_PENDING_EVENT_IDS) {
        const oldest = map.keys().next().value
        if (oldest !== undefined) map.delete(oldest)
      }
      map.set(id, trimTail((map.get(id) ?? '') + chunk))
    }
  }, [])

  const requestSync = useCallback(() => {
    if (syncRunningRef.current) syncAgainRef.current = true
    else void syncRef.current?.()
  }, [])

  // Write only the parts after the position this window holds. A part that does not
  // follow on means the feed dropped something; the catch-up read owns the repair.
  const noteParts = useCallback((id, parts, truncated = false) => {
    if (!Array.isArray(parts)) return
    let marker = truncated
    for (const part of parts) {
      if (!Number.isSafeInteger(part?.seq) || typeof part.text !== 'string') continue
      const held = positionsRef.current.get(id) ?? 0
      if (part.seq <= held) continue
      if (part.seq !== held + 1) {
        if (truncated) marker = true
        else {
          requestSync()
          break
        }
      }
      if (marker) {
        writeOutput(id, trimmedOutputMarker())
        marker = false
      }
      writeOutput(id, part.text)
      positionsRef.current.set(id, part.seq)
    }
  }, [requestSync, writeOutput])

  const applySyncList = useCallback((list) => {
    const items = Array.isArray(list) ? list.filter(item => item && item.id && !closedIdsRef.current.has(item.id)) : []
    const exitStates = new Map()
    for (const item of items) {
      if (Array.isArray(item.parts)) noteParts(item.id, item.parts, item.truncated === true)
      else if (typeof item.snapshot === 'string' && (positionsRef.current.get(item.id) ?? 0) === 0) {
        if ((item.start ?? 1) > 1) writeOutput(item.id, trimmedOutputMarker())
        writeOutput(item.id, trimTail(item.snapshot))
      }
      if (Number.isSafeInteger(item.end) && (positionsRef.current.get(item.id) ?? 0) < item.end && !Array.isArray(item.parts)) {
        positionsRef.current.set(item.id, item.end)
      }
      const pendingExit = pendingExitRef.current.get(item.id)
      pendingExitRef.current.delete(item.id)
      knownIdsRef.current.add(item.id)
      exitStates.set(item.id, {
        exited: item.exited === true || pendingExit?.exited === true,
        exitCode: item.exitCode ?? pendingExit?.exitCode ?? null,
      })
    }
    setState((current) => {
      const liveCurrent = current.terms.filter(item => !closedIdsRef.current.has(item.id))
      const byId = new Map(liveCurrent.map(item => [item.id, item]))
      const fresh = []
      for (const item of items) {
        const exitState = exitStates.get(item.id) ?? { exited: false, exitCode: null }
        const next = {
          id: item.id,
          cwd: item.cwd,
          title: item.title,
          pty: item.pty !== false,
          exited: exitState.exited,
          exitCode: exitState.exitCode,
          initialSnapshot: '',
        }
        if (byId.has(item.id)) byId.set(item.id, { ...byId.get(item.id), ...next, initialSnapshot: byId.get(item.id).initialSnapshot ?? '' })
        else fresh.push(next)
      }
      const kept = liveCurrent.map(item => byId.get(item.id) ?? item)
      const nextTerms = [...kept, ...fresh]
      const keepActive = current.activeId && !closedIdsRef.current.has(current.activeId) && nextTerms.some(item => item.id === current.activeId)
      return { terms: nextTerms, activeId: keepActive ? current.activeId : (nextTerms[0]?.id ?? null) }
    })
    return items.length
  }, [noteParts, writeOutput])

  const syncTerminals = useCallback(async () => {
    if (readOnly) return null
    if (syncPromiseRef.current) {
      syncAgainRef.current = true
      return syncPromiseRef.current
    }
    const run = (async () => {
      syncRunningRef.current = true
      let count = 0
      let ok = false
      try {
        do {
          syncAgainRef.current = false
          const positions = Object.fromEntries(positionsRef.current)
          const list = await call('terminal-list', { positions })
          if (!mountedRef.current) return count
          count = Math.max(count, applySyncList(list))
          ok = true
        } while (syncAgainRef.current)
      } catch {
        // The next feed hello tries again; terminal output itself never replaces what is held.
      } finally {
        syncRunningRef.current = false
      }
      return ok ? count : null
    })()
    syncPromiseRef.current = run
    try {
      return await run
    } finally {
      if (syncPromiseRef.current === run) syncPromiseRef.current = null
    }
  }, [readOnly, applySyncList])
  syncRef.current = syncTerminals

  const openNew = useCallback(async () => {
    if (readOnly) return
    openedOnceRef.current = true
    setOpening(true)
    setError('')
    try {
      const created = await call('terminal-open', { sessionId, cols: 96, rows: 28 })
      if (!mountedRef.current || closedIdsRef.current.has(created.id)) {
        if (closedIdsRef.current.has(created.id)) void call('terminal-close', { id: created.id }).catch(() => {})
        return
      }
      const pendingExit = pendingExitRef.current.get(created.id)
      pendingExitRef.current.delete(created.id)
      knownIdsRef.current.add(created.id)
      if ((pendingExit?.end ?? 0) > (positionsRef.current.get(created.id) ?? 0)) requestSync()
      setState((current) => {
        if (current.terms.some(item => item.id === created.id)) {
          return { ...current, activeId: created.id }
        }
        return {
          terms: [...current.terms, {
            id: created.id,
            cwd: created.cwd,
            title: created.title,
            pty: created.pty !== false,
            exited: pendingExit?.exited === true,
            exitCode: pendingExit?.exitCode ?? null,
            initialSnapshot: '',
          }],
          activeId: created.id,
        }
      })
    } catch (failure) {
      if (mountedRef.current) setError(hostText(failure?.message ?? String(failure)))
    } finally {
      if (mountedRef.current) setOpening(false)
    }
  }, [sessionId, readOnly])
  openNewRef.current = openNew

  // Load existing live terminals once on mount. The same positional sync repairs every
  // later feed reconnect; output already collected for not-yet-mounted xterms is stashed.
  useEffect(() => {
    if (readOnly) return undefined
    let alive = true
    void syncRef.current?.().then((count) => {
      if (!alive || count === null) return
      if (count > 0) openedOnceRef.current = true
      else if (!openedOnceRef.current && !autoOpenNonceRef.current) void openNewRef.current?.()
    })
    return () => { alive = false }
  }, [readOnly])

  // Triggered explicitly when the user selects "Terminal" from a menu.
  useEffect(() => {
    if (!autoOpenNonce || autoOpenNonce === lastAutoNonceRef.current || readOnly) return
    lastAutoNonceRef.current = autoOpenNonce
    openedOnceRef.current = true
    void openNew()
  }, [autoOpenNonce, readOnly, openNew])

  // Subscribe to live terminal output and exit events on the shared local SSE feed.
  useEffect(() => {
    if (!feed) return undefined
    const stashExit = (id, code, end) => {
      const map = pendingExitRef.current
      if (!map.has(id) && map.size >= MAX_PENDING_EVENT_IDS) {
        const oldest = map.keys().next().value
        if (oldest !== undefined) map.delete(oldest)
      }
      map.set(id, { exited: true, exitCode: code ?? null, end: Number.isSafeInteger(end) ? end : 0 })
    }
    return feed.on((event, data) => {
      if (event === 'hello') {
        void syncRef.current?.()
        return
      }
      if (!data?.id || closedIdsRef.current.has(data.id)) return
      if (event === 'terminal' && typeof data.chunk === 'string') {
        if (Array.isArray(data.parts)) noteParts(data.id, data.parts)
        else writeOutput(data.id, data.chunk)
      } else if (event === 'terminal-exit') {
        if (!knownIdsRef.current.has(data.id)) {
          stashExit(data.id, data.code, data.end)
          return
        }
        if (Number.isSafeInteger(data.end) && data.end > (positionsRef.current.get(data.id) ?? 0)) requestSync()
        setState(current => ({
          ...current,
          terms: current.terms.map(item => (item.id === data.id
            ? { ...item, exited: true, exitCode: data.code ?? null }
            : item)),
        }))
      }
    })
  }, [feed, noteParts, requestSync, writeOutput])

  const sendInput = useCallback(async (id, data) => {
    if (readOnly || closedIdsRef.current.has(id)) return
    setError('')
    try {
      await call('terminal-input', { id, data })
    } catch (failure) {
      if (mountedRef.current && !closedIdsRef.current.has(id)) {
        setError(hostText(failure?.message ?? String(failure)))
      }
    }
  }, [readOnly])

  const resizeTerm = useCallback(async (id, cols, rows) => {
    if (readOnly || closedIdsRef.current.has(id)) return
    try {
      await call('terminal-resize', { id, cols, rows })
    } catch { /* terminal closed or non-PTY */ }
  }, [readOnly])

  const closeTerm = useCallback(async (id) => {
    if (closedIdsRef.current.has(id)) return
    closedIdsRef.current.add(id)
    knownIdsRef.current.delete(id)
    pendingOutputRef.current.delete(id)
    pendingExitRef.current.delete(id)
    positionsRef.current.delete(id)
    const writer = writersRef.current.get(id)
    writersRef.current.delete(id)
    writer?.dispose?.()
    setState((current) => {
      const idx = current.terms.findIndex(item => item.id === id)
      if (idx === -1) return current
      const nextTerms = current.terms.filter(item => item.id !== id)
      const nextActive = current.activeId === id
        ? (nextTerms[Math.min(idx, nextTerms.length - 1)]?.id ?? null)
        : current.activeId
      return { terms: nextTerms, activeId: nextActive }
    })
    try {
      await call('terminal-close', { id })
    } catch { /* already closed */ }
  }, [])

  const selectTerm = useCallback((id) => {
    setState(current => (current.activeId === id ? current : { ...current, activeId: id }))
  }, [])

  const active = terms.find(item => item.id === activeId) ?? terms[0] ?? null

  const clearOutput = () => {
    if (!active) return
    pendingOutputRef.current.delete(active.id)
    const api = writersRef.current.get(active.id)
    api?.clear()
    api?.focus()
  }

  return h('div', { className: 'dsb-term' },
    h('div', { className: 'dsb-term-bar' },
      h('div', { ref: tabsRef, className: 'dsb-term-tabs', role: 'tablist' },
        terms.map((term, idx) => h('div', {
          key: term.id,
          className: 'dsb-term-tab',
          'data-active': term.id === active?.id || undefined,
        },
        h('button', {
          type: 'button',
          role: 'tab',
          className: 'dsb-term-tab-btn',
          'aria-selected': term.id === active?.id,
          onClick: () => selectTerm(term.id),
        },
        h(TerminalIcon),
        h('span', null, `${term.title} #${idx + 1}`),
        term.exited ? h('span', { className: 'dsb-term-exit' }, `${term.exitCode ?? 0}`) : null),
        h('button', {
          type: 'button',
          className: 'dsb-term-tab-x',
          'aria-label': t('Close'),
          title: t('Close'),
          onMouseDown: (event) => { event.preventDefault(); event.stopPropagation() },
          onClick: (event) => { event.stopPropagation(); void closeTerm(term.id) },
        }, h(CloseIcon))))),
      h('div', { className: 'dsb-term-actions' },
        active ? h('button', {
          type: 'button',
          className: 'dsb-term-act-btn',
          onClick: clearOutput,
        }, t('Clear')) : null,
        h('button', {
          type: 'button',
          className: 'dsb-term-act-ico',
          disabled: opening || readOnly,
          'aria-label': t('New terminal'),
          title: t('New terminal'),
          onClick: () => { void openNew() },
        }, h(PlusIcon)))),
    error ? h('div', { className: 'dsb-rp-error', role: 'alert' }, h('p', null, error)) : null,
    readOnly
      ? h('div', { className: 'dsb-rp-empty' }, t('Terminals are disabled in a read-only window'))
      : terms.length === 0
        ? h('div', { className: 'dsb-rp-empty' },
          h('p', null, t('No open terminals')),
          h('button', { type: 'button', className: 'bt-soft', disabled: opening, onClick: () => { void openNew() } },
            h(TerminalIcon), t('New terminal')))
        : h('div', { className: 'dsb-term-stage' },
          active ? h('div', { className: 'dsb-term-cwd-bar' },
            h('span', { className: 'dsb-term-cwd', title: active.cwd }, shortCwd(active.cwd, active.title)),
            active.exited ? h('span', { className: 'dsb-term-exited-note' }, t('Process exited ({code})', { code: active.exitCode ?? 0 })) : null) : null,
          terms.map(term => h(TerminalPane, {
            key: term.id,
            term,
            active: term.id === active?.id,
            readOnly,
            writersRef,
            pendingOutputRef,
            onSendInput: sendInput,
            onResize: resizeTerm,
          }))))
}
