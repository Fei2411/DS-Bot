// Interactive workspace terminal tab for the desktop right panel.
// Talks to ds-bot host `terminal-*` endpoints and receives live chunks via `api/bot/feed`.
import { createElement as h, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { call } from '../../../ds-bot/src/client/api.js'
import { hostText, t } from '../../../ds-bot/src/client/i18n.js'
import { CloseIcon, PlusIcon, TerminalIcon } from '../../../ds-bot/src/client/icons.js'

const MAX_CLIENT_BUFFER = 64 * 1024
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
 * Applies carriage-return line overwrites and strips OSC / non-SGR CSI sequences safely.
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
    for (const code of codes) {
      if (Number.isNaN(code) || code === 0) {
        fg = undefined
        bold = false
        dim = false
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
      setTerms(current => {
        if (current.some(item => item.id === created.id)) return current
        return [...current, { ...created, exited: false, exitCode: null, buffer: '' }]
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

  // Load existing live terminals once on mount; open a first shell automatically when none exist.
  useEffect(() => {
    if (readOnly) return undefined
    let alive = true
    void call('terminal-list', {})
      .then((list) => {
        if (!alive || !Array.isArray(list)) return
        const mapped = list.map(item => ({
          id: item.id,
          cwd: item.cwd,
          title: item.title,
          pty: item.pty,
          exited: item.exited === true,
          exitCode: item.exitCode ?? null,
          buffer: String(item.snapshot ?? ''),
        }))
        setTerms(mapped)
        if (mapped.length > 0) {
          openedOnceRef.current = true
          setActiveId(current => current ?? mapped[0].id)
        } else if (!openedOnceRef.current) {
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
    void openNew()
  }, [autoOpenNonce, readOnly, openNew])

  // Subscribe to live terminal output and exit events on the shared SSE feed.
  useEffect(() => {
    if (!feed) return undefined
    return feed.on((event, data) => {
      if (event === 'terminal' && data?.id && typeof data.chunk === 'string') {
        setTerms(current => current.map(item => (item.id === data.id
          ? { ...item, buffer: trimTail(item.buffer + data.chunk) }
          : item)))
      } else if (event === 'terminal-exit' && data?.id) {
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
    await sendInput(`${line}\n`)
  }

  const closeTerm = async (id) => {
    setTerms((current) => {
      const next = current.filter(item => item.id !== id)
      if (active?.id === id) setActiveId(next[0]?.id ?? null)
      return next
    })
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
                  if (event.key.toLowerCase() === 'c') {
                    event.preventDefault()
                    void sendInput('\x03')
                    return
                  }
                  if (event.key.toLowerCase() === 'd') {
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
            !active.exited ? h('button', {
              type: 'button',
              className: 'bt-soft bt-soft-sm',
              title: 'Ctrl+C',
              onClick: () => { void sendInput('\x03') },
            }, 'Ctrl+C') : null),
          ])
}
