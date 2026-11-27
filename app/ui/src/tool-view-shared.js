// Shared UI shell and pure helpers for built-in tool call cards.
// Kept in a leaf module so specialized tool view modules never form circular imports.
import { createElement as h, useState } from 'react'
import { writeClipboard } from '../../../ds-bot/src/client/dsh-primitives.js'
import { CheckIcon, ChevronRightIcon, CopyIcon } from '../../../ds-bot/src/client/icons.js'
import { t } from '../../../ds-bot/src/client/i18n.js'

export function compact(value, max = 96) {
  const flat = String(value ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export function readArgText(block, ...keys) {
  for (const key of keys) {
    const value = block?.args?.text?.(key)
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}

export function readArgValue(block, key) {
  const fromPartial = block?.args?.value?.(key)
  if (fromPartial !== undefined) return fromPartial
  const raw = block?.call?.argsRaw ?? block?.argsRaw
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed[key] : undefined
  } catch {
    return undefined
  }
}

export function shortPath(raw, cwd) {
  if (typeof raw !== 'string' || raw === '') return ''
  if (typeof cwd === 'string' && cwd !== '') {
    const normRaw = raw.replaceAll('\\', '/')
    const normCwd = cwd.replaceAll('\\', '/').replace(/\/+$/, '')
    if (normRaw === normCwd) return '.'
    if (normRaw.startsWith(`${normCwd}/`)) return normRaw.slice(normCwd.length + 1)
  }
  return raw
}

// Exact mirror of `@deepseek-ai/dsh-shell/render` `parseExitStatus`.
export function parseExitStatus(text) {
  const source = typeof text === 'string' ? text : ''
  const signal = /\n\[killed by signal: ([^\]\n]+)\]$/.exec(source)
  if (signal?.[1] !== undefined) {
    return { body: source.slice(0, signal.index), signal: signal[1] }
  }
  const exit = /\n\[exit code: (\d+)\]$/.exec(source)
  if (exit?.[1] !== undefined) {
    return { body: source.slice(0, exit.index), exitCode: Number(exit[1]) }
  }
  return { body: source, exitCode: 0 }
}

export function safeWebHref(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  try {
    const parsed = new URL(raw.trim())
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    const host = parsed.hostname.replace(/^www\./i, '')
    const path = parsed.pathname === '/' ? '' : parsed.pathname
    return { href: parsed.toString(), host, display: `${host}${path}` }
  } catch {
    return null
  }
}

export function errorLineOf(block, isError) {
  if (!isError) return ''
  return [block?.error?.code, block?.error?.reason].filter(Boolean).join(' · ')
}

export function MiniCopy({ text }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void writeClipboard(text).then((ok) => {
      if (!ok) return
      setCopied(true)
      setTimeout(() => setCopied(false), 1000)
    })
  }
  return h('button', {
    type: 'button',
    className: 'bt-mini dsb-tool-copy',
    'aria-label': copied ? t('Copied') : t('Copy'),
    title: copied ? t('Copied') : t('Copy'),
    onClick: copy,
  }, copied ? h(CheckIcon) : h(CopyIcon))
}

export function ToolCardShell({
  icon,
  label,
  summary,
  summaryTitle,
  badges,
  headerAction,
  phase,
  isError,
  duration,
  expanded,
  onToggle,
  hasBody,
  children,
}) {
  const running = phase === 'preparing' || phase === 'start'
  const headButton = h('button', {
    type: 'button',
    className: 'dsb-tool-head',
    disabled: !hasBody,
    'aria-expanded': hasBody ? expanded : undefined,
    onClick: hasBody ? onToggle : undefined,
  },
  h('span', { className: 'dsb-tool-dot', 'aria-hidden': true }),
  icon ? h('span', { className: 'dsb-tool-icon', 'aria-hidden': true }, h(icon)) : null,
  h('span', { className: 'dsb-tool-name' }, label),
  summary ? h('span', { className: 'dsb-tool-summary', title: summaryTitle ?? summary }, summary) : null,
  h('span', { className: 'dsb-tool-meta' },
    badges,
    running ? h('span', { className: 'dsb-tool-state' }, t('Running'))
      : isError && (!badges || badges.length === 0) ? h('span', { className: 'dsb-tool-state' }, t('Error'))
        : duration ? h('span', { className: 'dsb-tool-time' }, duration) : null,
    hasBody ? h('span', { className: 'dsb-tool-chev', 'aria-hidden': true }, h(ChevronRightIcon)) : null))

  return h('div', {
    className: 'dsb-tool',
    'data-phase': phase,
    'data-error': isError || undefined,
    'data-open': expanded || undefined,
  },
  headerAction
    ? h('div', { className: 'dsb-tool-head-row' },
        headButton,
        h('div', { className: 'dsb-tool-head-action' }, headerAction))
    : headButton,
  expanded && hasBody ? h('div', { className: 'dsb-tool-body' }, children) : null)
}
