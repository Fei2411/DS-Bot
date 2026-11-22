// Interactive workspace terminal tab for the desktop right panel.
// Talks to ds-bot host `terminal-*` endpoints and receives live chunks via local `api/bot/feed`.
import { createElement as h, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { call } from '../../../ds-bot/src/client/api.js'
import { hostText, t } from '../../../ds-bot/src/client/i18n.js'
import { CloseIcon, PlusIcon, TerminalIcon } from '../../../ds-bot/src/client/icons.js'

const MAX_CLIENT_BUFFER = 64 * 1024
const MAX_PENDING_EVENT_IDS = 16
const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)
const ANSI_TOKEN_RE = new RegExp(`${ESC}\\[([0-9;?]*)([@-~])|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, 'g')

const FG_CODES = new Map([
  [30, 'gray'], [31, 'red'], [32, 'green'], [33, 'yellow'], [34, 'blue'], [35, 'magenta'], [36, 'cyan'], [37, 'ink'],
  [90, 'gray'], [91, 'red'], [92, 'green'], [93, 'yellow'], [94, 'blue'], [95, 'magenta'], [96, 'cyan'], [97, 'ink'],
])

function normalizeCarriageReturns(raw) {
  return String(raw ?? '')
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((line) => {
      if (!line.includes('\r')) return line
      let out = ''
      for (const part of line.split('\r')) {
        if (part !== '') out = part
      }
      return out
    })
    .join('\n')
}

function shortCwd(cwd, fallback) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return fallback || ''
  const parts = cwd.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 2) return cwd
  return `…/${parts.slice(-2).join('/')}`
}

/**
 * Parses ANSI escape sequences into lightweight styled text spans for terminal output.
 * Applies carriage-return line overwrites, skips 256-color/RGB SGR parameter tuples,
 * and strips OSC / non-SGR CSI control sequences safely.
 * @param {string} raw
 * @returns {Array<{ text: string, fg?: string, bold?: boolean, dim?: boolean }>}
 */
export function parseAnsiSpans(raw) {
  const input = normalizeCarriageReturns(raw)
  const spans = []
  let fg
  let bold = false
  let dim = false
  let lastIndex = 0
  ANSI_TOKEN_RE.lastIndex = 0
  for (let match = ANSI_TOKEN_RE.exec(input); match !== null; match = ANSI_TOKEN_RE.exec(input)) {
    if (match.index > lastIndex) {
      spans.push({ text: input.slice(lastIndex, match.index), ...(fg ? { fg } : {}), ...(bold ? { bold } : {}), ...(dim ? { dim } : {}) })
    }
    lastIndex = match.index + match[0].length
    const params = match[1]
    const finalByte = match[2]
    if (finalByte !== 'm') continue
    const codes = (params === '' ? '0' : params).split(';').map(n => Number.parseInt(n, 10))
    for (let i = 0; i < codes.length; i += 1) {
      const code = codes[i]
      if (Number.isNaN(code) || code === 0) {
        fg = undefined
        bold = false
        dim = false
      } else if (code === 38 || code === 48) {
        // Consume 256-color (38;5;n) or truecolor (38;2;r;g;b) parameter tuples cleanly.
        const mode = codes[i + 1]
        if (mode === 5) i += 2
        else if (mode === 2) i += 4
      } else if (code === 1) {
        bold = true
      } else if (code === 2) {
        dim = true
      } else if (code === 22) {
        bold = false
        dim = false
      } else if (code === 39) {
        fg = undefined
      } else if (FG_CODES.has(code)) {
        fg = FG_CODES.get(code)
      }
    }
  }
  if (lastIndex < input.length) {
    spans.push({ text: input.slice(lastIndex), ...(fg ? { fg } : {}), ...(bold ? { bold } : {}), ...(dim ? { dim } : {}) })
  }
  return spans
}

const trimTail = text => (text.length > MAX_CLIENT_BUFFER ? text.slice(text.length - MAX_CLIENT_BUFFER) : text)

/**
 * Interactive local terminal tabs bound to the active Bot/room workspace folder.
 */
export function WorkspaceTerminal({ sessionId, feed, readOnly = false, autoOpenNonce = 0 }) {
  const [terms, setTerms] = useState([])
  const [activeId, setActiveId] = useState(null)
  const [command, setCommand] = useState('')
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState('')
  const historyRef = useRef([])
  const historyIdxRef = useRef(-1)
  const outputRef = useRef(null)
  const inputRef = useRef(null)
  const mountedRef = useRef(true)
  const lastAutoNonceRef = useRef(0)
  const openedOnceRef = useRef(false)
  const openNewRef = useRef(null)
  const autoOpenNonceRef = useRef(autoOpenNonce)
  autoOpenNonceRef.current = autoOpenNonce
  // Buffers early SSE chunks/exits that arrive before `terminal-open` resolves.
  const pendingEventsRef = useRef(new Map())
  const knownIdsRef = useRef(new Set())
  knownIdsRef.current = new Set(terms.map(item => item.id))

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const openNew = useCallback(async () => {
    if (readOnly) return
    openedOnceRef.current = true
    setOpening(true)
    setError('')
    try {
      const created = await call('terminal-open', { sessionId, cols: 96, rows: 28 })
      if (!mountedRef.current) return
      const pending = pendingEventsRef.current.get(created.id)
      pendingEventsRef.current.delete(created.id)
      // Mark id known synchronously before React commits `setTerms` so no SSE chunk arriving
      // in the micro-window between drain and re-render is stashed back into `pendingEventsRef`.
      knownIdsRef.current.add(created.id)
      setTerms((current) => {
        if (current.some(item => item.id === created.id)) return current
        return [...current, {
          ...created,
          exited: pending?.exited === true,
          exitCode: pending?.exitCode ?? null,
          buffer: trimTail(pending?.buffer ?? ''),
        }]
      })
      setActiveId(created.id)
      setTimeout(() => inputRef.current?.focus?.(), 0)
    } catch (failure) {
      if (mountedRef.current) setError(hostText(failure?.message ?? String(failure)))
    } finally {
      if (mountedRef.current) setOpening(false)
    }
  }, [sessionId, readOnly])
  openNewRef.current = openNew

  // Load existing live terminals once on mount, merging by id so a concurrent `terminal-open`
  // is never overwritten; auto-open a first shell when none exist and `autoOpenNonce` did not.
  useEffect(() => {
    if (readOnly) return undefined
    let alive = true
    void call('terminal-list', {})
      .then((list) => {
        if (!alive || !Array.isArray(list)) return
        const mapped = list.map((item) => {
          const pending = pendingEventsRef.current.get(item.id)
          pendingEventsRef.current.delete(item.id)
          knownIdsRef.current.add(item.id)
          return {
            id: item.id,
            cwd: item.cwd,
            title: item.title,
            pty: item.pty,
            exited: item.exited === true || pending?.exited === true,
            exitCode: item.exitCode ?? pending?.exitCode ?? null,
            buffer: trimTail(String(item.snapshot ?? '') + (pending?.buffer ?? '')),
          }
        })
        setTerms((current) => {
          if (current.length === 0) return mapped
          const existing = new Set(current.map(item => item.id))
          const missing = mapped.filter(item => !existing.has(item.id))
          return missing.length === 0 ? current : [...missing, ...current]
        })
        if (mapped.length > 0) {
          openedOnceRef.current = true
          setActiveId(current => current ?? mapped[0].id)
        } else if (!openedOnceRef.current && !autoOpenNonceRef.current) {
          void openNewRef.current?.()
        }
      })
      .catch(() => {})
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
    const stash = (id, patch) => {
      const map = pendingEventsRef.current
      if (!map.has(id) && map.size >= MAX_PENDING_EVENT_IDS) {
        const oldest = map.keys().next().value
        if (oldest !== undefined) map.delete(oldest)
      }
      const prev = map.get(id) ?? { buffer: '', exited: false, exitCode: null }
      map.set(id, {
        buffer: patch.chunk ? trimTail(prev.buffer + patch.chunk) : prev.buffer,
        exited: patch.exited ?? prev.exited,
        exitCode: patch.exitCode !== undefined ? patch.exitCode : prev.exitCode,
      })
    }
    return feed.on((event, data) => {
      if (event === 'terminal' && data?.id && typeof data.chunk === 'string') {
        if (!knownIdsRef.current.has(data.id)) {
          stash(data.id, { chunk: data.chunk })
          return
        }
        setTerms(current => current.map(item => (item.id === data.id
          ? { ...item, buffer: trimTail(item.buffer + data.chunk) }
          : item)))
      } else if (event === 'terminal-exit' && data?.id) {
        if (!knownIdsRef.current.has(data.id)) {
          stash(data.id, { exited: true, exitCode: data.code ?? null })
          return
        }
        setTerms(current => current.map(item => (item.id === data.id
          ? { ...item, exited: true, exitCode: data.code ?? null }
          : item)))
      }
    })
  }, [feed])

  const active = terms.find(item => item.id === activeId) ?? terms[0] ?? null
  const spans = useMemo(() => parseAnsiSpans(active?.buffer ?? ''), [active?.buffer])

  useEffect(() => {
    const node = outputRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [active?.id, active?.buffer])

  const sendInput = async (data) => {
    if (!active || active.exited || readOnly) return
    setError('')
    try {
      await call('terminal-input', { id: active.id, data })
    } catch (failure) {
      if (mountedRef.current) setError(hostText(failure?.message ?? String(failure)))
    }
  }

  const submitCommand = async () => {
    if (!active || active.exited || readOnly) return
    const line = command
    setCommand('')
    if (line.trim() !== '') {
      historyRef.current = [line, ...historyRef.current.slice(0, 49)]
    }
    historyIdxRef.current = -1
    if (!active.pty) {
      setTerms(current => current.map(item => (item.id === active.id
        ? { ...item, buffer: trimTail(`${item.buffer}$ ${line}\n`) }
        : item)))
    }
    // PTYs expect CR (`\r`) for Enter (required on Windows ConPTY and standard on POSIX);
    // pipe-backed fallback shells expect LF (`\n`).
    await sendInput(active.pty ? `${line}\r` : `${line}\n`)
  }

  const closeTerm = async (id) => {
    const remaining = terms.filter(item => item.id !== id)
    pendingEventsRef.current.delete(id)
    setTerms(remaining)
    if (active?.id === id) setActiveId(remaining[0]?.id ?? null)
    try {
      await call('terminal-close', { id })
    } catch { /* already closed */ }
  }

  const clearOutput = () => {
    if (!active) return
    setTerms(current => current.map(item => (item.id === active.id ? { ...item, buffer: '' } : item)))
  }

  return h('div', { className: 'dsb-term' },
    h('div', { className: 'dsb-term-bar' },
      h('div', { className: 'dsb-term-tabs', role: 'tablist' },
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
          onClick: () => setActiveId(term.id),
        },
        h(TerminalIcon),
        h('span', null, `${term.title} #${idx + 1}`),
        term.exited ? h('span', { className: 'dsb-term-exit' }, `${term.exitCode ?? 0}`) : null),
        h('button', {
          type: 'button',
          className: 'dsb-term-tab-x',
          'aria-label': t('Close'),
          title: t('Close'),
          onClick: () => { void closeTerm(term.id) },
        }, h(CloseIcon))))),
      h('div', { className: 'dsb-term-actions' },
        active ? h('button', {
          type: 'button',
          className: 'bt-soft bt-soft-sm',
          onClick: clearOutput,
        }, t('Clear')) : null,
        h('button', {
          type: 'button',
          className: 'bt-icon-btn',
          disabled: opening || readOnly,
          'aria-label': t('New terminal'),
          title: t('New terminal'),
          onClick: () => { void openNew() },
        }, h(PlusIcon)))),
    error ? h('div', { className: 'dsb-rp-error', role: 'alert' }, h('p', null, error)) : null,
    readOnly
      ? h('div', { className: 'dsb-rp-empty' }, t('Terminals are disabled in a read-only window'))
      : !active
        ? h('div', { className: 'dsb-rp-empty' },
          h('p', null, t('No open terminals')),
          h('button', { type: 'button', className: 'bt-soft', disabled: opening, onClick: () => { void openNew() } },
            h(TerminalIcon), t('New terminal')))
        : [
            h('div', {
              key: 'out',
              ref: outputRef,
              className: 'dsb-term-out',
              onClick: () => inputRef.current?.focus?.(),
            },
            h('div', { className: 'dsb-term-cwd', title: active.cwd }, shortCwd(active.cwd, active.title)),
            h('pre', { className: 'dsb-term-pre' },
              spans.length === 0
                ? h('span', { className: 'dsb-term-placeholder' }, t('Ready'))
                : spans.map((span, idx) => h('span', {
                  key: idx,
                  className: [
                    span.fg ? `is-fg-${span.fg}` : '',
                    span.bold ? 'is-bold' : '',
                    span.dim ? 'is-dim' : '',
                  ].filter(Boolean).join(' ') || undefined,
                }, span.text)))),
            h('form', {
              key: 'in',
              className: 'dsb-term-input-row',
              onSubmit: (event) => { event.preventDefault(); void submitCommand() },
            },
            h('span', { className: 'dsb-term-prompt', 'aria-hidden': true }, '$'),
            h('input', {
              ref: inputRef,
              type: 'text',
              className: 'dsb-term-input',
              value: command,
              disabled: active.exited || readOnly,
              placeholder: active.exited ? t('Process exited ({code})', { code: active.exitCode ?? 0 }) : t('Run a command…'),
              'aria-label': t('Terminal command'),
              onChange: event => setCommand(event.target.value),
              onKeyDown: (event) => {
                if (event.ctrlKey && !event.metaKey && !event.altKey) {
                  if (event.key.toLowerCase() === 'c' && active.pty) {
                    event.preventDefault()
                    void sendInput('\x03')
                    return
                  }
                  if (event.key.toLowerCase() === 'd' && active.pty) {
                    event.preventDefault()
                    void sendInput('\x04')
                    return
                  }
                  if (event.key.toLowerCase() === 'l') {
                    event.preventDefault()
                    clearOutput()
                    return
                  }
                }
                if (event.key === 'ArrowUp' && historyRef.current.length > 0) {
                  event.preventDefault()
                  const nextIdx = Math.min(historyIdxRef.current + 1, historyRef.current.length - 1)
                  historyIdxRef.current = nextIdx
                  setCommand(historyRef.current[nextIdx] ?? '')
                } else if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  const nextIdx = historyIdxRef.current - 1
                  historyIdxRef.current = nextIdx
                  setCommand(nextIdx < 0 ? '' : (historyRef.current[nextIdx] ?? ''))
                }
              },
            }),
            active.pty ? h('button', {
              type: 'button',
              className: 'bt-soft bt-soft-sm',
              disabled: active.exited || readOnly,
              title: 'Ctrl+C',
              onClick: () => { void sendInput('\x03') },
            }, 'Ctrl+C') : null),
          ])
}
