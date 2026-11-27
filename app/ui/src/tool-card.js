// Tool call presentation for the desktop window's own interface:
// dispatches every atomic call (and nested PTC sub-call) through the DSH-compatible
// `tool.call.toolview` slot keyed by wire tool name, falling back to `GenericToolCard`
// (name, summary, status, arguments, and foldable result).
import { createElement as h, useCallback, useMemo, useState } from 'react'
import { writeClipboard } from '../../../ds-bot/src/client/dsh-primitives.js'
import { CheckIcon, ChevronRightIcon, CopyIcon } from '../../../ds-bot/src/client/icons.js'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { elapsedLabel } from '../../../ds-bot/src/client/text.js'
import { SlotOutlet, TOOL_VIEW_SLOT, slots as defaultSlots } from './slots.js'

const SUMMARY_KEYS = ['description', 'file_path', 'path', 'command', 'cmd', 'query', 'pattern', 'url', 'to', 'bot', 'group', 'name', 'title']
const SUMMARY_MAX = 96
const FOLD_LINES = 12
const FOLD_CHARS = 1200

const NOOP_OPEN_FILE = () => {}
const NOOP_LOAD_IMAGE = () => Promise.resolve(undefined)

function compactLine(value) {
  const flat = String(value ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > SUMMARY_MAX ? `${flat.slice(0, SUMMARY_MAX - 1)}…` : flat
}

export function argSummary(args) {
  if (!args) return ''
  for (const key of SUMMARY_KEYS) {
    const value = args.textPrefix?.(key, SUMMARY_MAX + 1) ?? args.text?.(key)
    if (value && value.trim() !== '') return compactLine(value)
  }
  const keys = typeof args.keys === 'function' ? args.keys() : []
  for (const key of keys) {
    const value = args.textPrefix?.(key, SUMMARY_MAX + 1) ?? args.text?.(key)
    if (typeof value === 'string' && value.trim() !== '') return compactLine(value)
  }
  return ''
}

export function formatArgs(block) {
  const raw = block?.call?.argsRaw ?? block?.argsRaw ?? ''
  if (typeof raw !== 'string' || raw.trim() === '') return ''
  const trimmed = raw.trim()
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed !== null && typeof parsed === 'object') {
      if (!Array.isArray(parsed) && Object.keys(parsed).length === 0) return ''
      return JSON.stringify(parsed, null, 2)
    }
  } catch { /* streaming or malformed JSON: show raw text */ }
  return trimmed === '{}' ? '' : trimmed
}

export function formatResult(block) {
  const parts = []
  for (const item of Array.isArray(block?.content) ? block.content : []) {
    if (item?.type === 'text' && typeof item.text === 'string' && item.text !== '') {
      parts.push(item.text)
    } else if (item?.type === 'image') {
      parts.push(`[image${item.attachment?.name ? `: ${item.attachment.name}` : ''}]`)
    } else if (item?.type === 'file') {
      parts.push(`[file${item.attachment?.name ? `: ${item.attachment.name}` : ''}]`)
    } else if (item !== null && item !== undefined) {
      try { parts.push(JSON.stringify(item, null, 2)) } catch { parts.push(String(item)) }
    }
  }
  return parts.join('\n')
}

export function clipLongText(text) {
  if (typeof text !== 'string' || text === '') return { shown: '', folded: false, lines: 0 }
  const split = text.split('\n')
  const tooLong = split.length > FOLD_LINES || text.length > FOLD_CHARS
  if (!tooLong) return { shown: text, folded: false, lines: split.length }
  let head = split.slice(0, FOLD_LINES).join('\n')
  if (head.length > FOLD_CHARS) head = head.slice(0, FOLD_CHARS)
  return { shown: `${head}\n…`, folded: true, lines: split.length }
}

export function CodeSection({ label, text, error = false }) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const clipped = useMemo(() => clipLongText(text), [text])
  const visible = expanded || !clipped.folded ? text : clipped.shown
  const copy = () => {
    void writeClipboard(text).then((ok) => {
      if (!ok) return
      setCopied(true)
      setTimeout(() => setCopied(false), 1000)
    })
  }
  return h('div', { className: 'dsb-tool-sec', 'data-error': error || undefined },
    h('div', { className: 'dsb-tool-sec-head' },
      h('span', { className: 'dsb-tool-sec-label' }, label),
      h('button', {
        type: 'button',
        className: 'bt-mini dsb-tool-copy',
        'aria-label': copied ? t('Copied') : t('Copy'),
        title: copied ? t('Copied') : t('Copy'),
        onClick: copy,
      }, copied ? h(CheckIcon) : h(CopyIcon))),
    h('pre', { className: 'dsb-tool-pre' }, h('code', null, visible)),
    clipped.folded ? h('button', {
      type: 'button',
      className: 'dsb-tool-fold',
      'aria-expanded': expanded,
      onClick: () => setExpanded(value => !value),
    }, expanded ? t('Show less') : t('Show all ({count} lines)', { count: clipped.lines })) : null)
}

export function formatToolDuration(block, phase) {
  const durationMs = phase === 'result' && Number.isFinite(block?.time) && Number.isFinite(block?.callTime)
    ? block.time - block.callTime
    : undefined
  return Number.isFinite(durationMs) && durationMs >= 1000 ? elapsedLabel(durationMs) : ''
}

// Stable disclosure hook matching DSH's `UseDisclosure` contract (accepting an optional initial state).
function useToolDisclosure(initial = false) {
  const [expanded, setExpanded] = useState(initial)
  const toggle = useCallback(() => setExpanded(value => !value), [])
  return useMemo(() => ({ expanded, setExpanded, toggle }), [expanded, toggle])
}

export function GenericToolCard({ callId, toolName, phase, block, useDisclosure }) {
  const disclosure = useDisclosure()
  const running = phase === 'preparing' || phase === 'start'
  const isError = phase === 'result' && block?.isError === true
  const summary = useMemo(() => argSummary(block?.args), [block?.args])
  const argsText = useMemo(() => formatArgs(block), [block])
  const resultText = useMemo(() => (phase === 'result' ? formatResult(block) : ''), [phase, block])
  const errorLine = useMemo(() => {
    if (!isError) return ''
    const bits = [block?.error?.code, block?.error?.reason].filter(Boolean)
    return bits.join(' · ')
  }, [isError, block?.error])
  const hasBody = argsText !== '' || resultText !== '' || errorLine !== ''
  const title = toolName || (callId ? `${t('Tool call')} · ${callId}` : t('Tool call'))
  const duration = formatToolDuration(block, phase)

  return h('div', {
    className: 'dsb-tool',
    'data-phase': phase,
    'data-error': isError || undefined,
    'data-open': disclosure.expanded || undefined,
  },
  h('button', {
    type: 'button',
    className: 'dsb-tool-head',
    disabled: !hasBody,
    'aria-expanded': hasBody ? disclosure.expanded : undefined,
    onClick: hasBody ? disclosure.toggle : undefined,
  },
  h('span', { className: 'dsb-tool-dot', 'aria-hidden': true }),
  h('span', { className: 'dsb-tool-name' }, title),
  summary ? h('span', { className: 'dsb-tool-summary', title: summary }, summary) : null,
  running ? h('span', { className: 'dsb-tool-state' }, t('Running'))
    : isError ? h('span', { className: 'dsb-tool-state' }, t('Error'))
      : duration ? h('span', { className: 'dsb-tool-time' }, duration) : null,
  hasBody ? h('span', { className: 'dsb-tool-chev', 'aria-hidden': true }, h(ChevronRightIcon)) : null),
  disclosure.expanded && hasBody ? h('div', { className: 'dsb-tool-body' },
    argsText !== '' ? h(CodeSection, { label: t('Arguments'), text: argsText }) : null,
    errorLine !== '' ? h('div', { className: 'dsb-tool-errline', role: 'status' }, errorLine) : null,
    resultText !== '' ? h(CodeSection, { label: isError ? t('Error') : t('Result'), text: resultText, error: isError }) : null) : null)
}

function phaseOf(block, fallback) {
  if (block?.kind === 'tool-result') return 'result'
  if (block?.phase === 'preparing' || block?.phase === 'start' || block?.phase === 'result') return block.phase
  return fallback ?? 'start'
}

function ToolCallBranch({
  block, cwd, openFile, loadImage, registry, fallback,
  sessionId, botId, roster, actions, feed, readOnly, hooks, subagentCatalog, onOpenSubagent,
}) {
  const callId = block?.callId ?? ''
  const toolName = block?.name || block?.call?.name || ''
  const phase = phaseOf(block)
  const ownerProps = {
    useDisclosure: useToolDisclosure,
    callId,
    toolName,
    cwd,
    openFile: openFile ?? NOOP_OPEN_FILE,
    loadImage: loadImage ?? NOOP_LOAD_IMAGE,
    phase,
    block,
    sessionId,
    botId,
    roster,
    actions,
    feed,
    readOnly: Boolean(readOnly),
    hooks,
    subagentCatalog,
    onOpenSubagent,
  }
  const subCalls = Array.isArray(block?.subCalls) ? block.subCalls : []
  const renderFallback = () => (typeof fallback === 'function' ? fallback(ownerProps) : h(GenericToolCard, ownerProps))
  // Orphan tool/result with no toolName bypasses slot lookup so it never matches an unkeyed slot.
  const card = toolName === ''
    ? renderFallback()
    : h(SlotOutlet, {
      registry,
      name: TOOL_VIEW_SLOT,
      slotKey: toolName,
      resetKey: `${callId}:${phase}`,
      props: ownerProps,
      fallback: renderFallback,
    })
  const anchor = {
    className: subCalls.length > 0 ? 'dsb-tool-tree' : 'dsb-tool-wrap',
    'data-chat-anchor-key': callId ? `call:${callId}` : undefined,
    'data-chat-call-id': callId || undefined,
  }
  if (subCalls.length === 0) return h('div', anchor, card)
  return h('div', anchor,
    card,
    h('div', { className: 'dsb-tool-children' },
      subCalls.map((child, index) => h(ToolCallBranch, {
        key: child?.callId ? `call:${child.callId}` : `sub:${index}`,
        block: child,
        cwd,
        openFile,
        loadImage,
        registry,
        fallback,
        sessionId,
        botId,
        roster,
        actions,
        feed,
        readOnly,
        hooks,
        subagentCatalog,
        onOpenSubagent,
      }))))
}

/**
 * Renders one tool call entry (or raw ToolCallBlock) and any nested PTC sub-calls,
 * dispatching each atomic call through `tool.call.toolview` before falling back to `GenericToolCard`.
 */
export function ToolCallCard({
  entry, block, cwd, openFile, loadImage, registry = defaultSlots, fallback,
  sessionId, botId, roster, actions, feed, readOnly, hooks, subagentCatalog, onOpenSubagent,
}) {
  const target = block ?? entry?.block
  if (!target) return null
  return h(ToolCallBranch, {
    block: target, cwd, openFile, loadImage, registry, fallback,
    sessionId, botId, roster, actions, feed, readOnly, hooks, subagentCatalog, onOpenSubagent,
  })
}
