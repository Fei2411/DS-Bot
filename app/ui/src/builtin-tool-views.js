// Built-in `tool.call.toolview` renderers for DSH's core coding & system tools.
// Registered at BUILTIN_TOOL_PRIORITY (100) so user/plugin views at default priority (0)
// always win cleanly. Every meta parser defensively narrows DSH 0.2.2-rc.1 contracts
// (FsReadMeta, FsDiffMeta, SearchMeta, WebSearchMeta, WebFetchMeta, shell exit markers)
// and degrades gracefully to folded output when replay metadata is absent.
import { createElement as h, useEffect, useMemo, useRef, useState } from 'react'
import { fileSizeText } from '../../../ds-bot/src/client/dsh-primitives.js'
import {
  BlocksIcon,
  CheckIcon,
  CodeIcon,
  DiffIcon,
  FileIcon,
  FolderIcon,
  GlobeIcon,
  ImageIcon,
  ListCheckIcon,
  SearchIcon,
  TerminalIcon,
} from '../../../ds-bot/src/client/icons.js'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { BROWSER_TOOL_NAMES, BrowserToolView, ComputerToolView } from './browser-computer-tool-views.js'
import { ToolImageThumb } from './image-lightbox.js'
import { OFFICE_TOOL_NAMES, OfficeCliCard, OfficeToolView, parseOfficeCliCommand } from './office-tool-view.js'
import { TOOL_VIEW_SLOT, slots as defaultSlots } from './slots.js'
import {
  BackgroundJobPanel,
  JOB_TOOL_NAMES,
  JobToolView,
  SUBAGENT_TOOL_NAMES,
  SubagentToolView,
  parseBackgroundJobIdFromShell,
} from './subagent-job-tool-views.js'
import { CodeSection, argSummary, formatArgs, formatResult, formatToolDuration } from './tool-card.js'
import {
  MiniCopy,
  ToolCardShell,
  compact,
  errorLineOf,
  parseExitStatus,
  readArgText,
  readArgValue,
  safeWebHref,
  shortPath,
} from './tool-view-shared.js'

export { parseExitStatus, safeWebHref, shortPath }

export const BUILTIN_TOOL_PRIORITY = 100

const READ_FOLD_LINES = 16
const DIFF_FOLD_LINES = 20
const SEARCH_FOLD_ITEMS = 16
const MAX_LCS_CELLS = 40_000

// Defensive narrowing of DSH `FsReadMeta` (`@deepseek-ai/dsh-tool-fs/read-render`).
export function readMetaFromMeta(meta) {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const { path, offset, lines, totalLines, lang } = meta
  if (typeof path !== 'string' || path === '') return undefined
  if (!Number.isInteger(offset) || offset < 1) return undefined
  if (!Number.isInteger(totalLines) || totalLines < 0) return undefined
  if (!Array.isArray(lines)) return undefined
  let prev = offset - 1
  for (const line of lines) {
    if (typeof line !== 'object' || line === null) return undefined
    if (!Number.isInteger(line.number) || line.number <= prev || line.number > totalLines) return undefined
    if (typeof line.text !== 'string') return undefined
    prev = line.number
  }
  return {
    path,
    offset,
    lines,
    totalLines,
    ...(typeof lang === 'string' && lang !== '' ? { lang } : {}),
  }
}

// Defensive narrowing of DSH `FsDiffMeta` (`@deepseek-ai/dsh-tool-fs/diff` & `apply_patch`).
// Note: DSH `write` on a newly created file emits `{ operation: 'create', path, diffs: [] }`.
export function diffMetaFromMeta(meta) {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  if (!Array.isArray(meta.diffs)) return undefined
  const diffs = []
  for (const item of meta.diffs) {
    if (typeof item !== 'object' || item === null) return undefined
    if (typeof item.path !== 'string' || item.path === '') return undefined
    if (item.oldText !== null && typeof item.oldText !== 'string') return undefined
    if (typeof item.newText !== 'string') return undefined
    diffs.push({ path: item.path, oldText: item.oldText, newText: item.newText })
  }
  const operation = meta.operation === 'create' || meta.operation === 'update' ? meta.operation : undefined
  const path = typeof meta.path === 'string' && meta.path !== '' ? meta.path : undefined
  const stopped = meta.stopped === true ? true : undefined
  if (diffs.length === 0 && operation === undefined && path === undefined && stopped === undefined) return undefined
  return {
    diffs,
    ...(operation ? { operation } : {}),
    ...(path ? { path } : {}),
    ...(stopped ? { stopped } : {}),
  }
}

// Keep line terminators attached to each token so adding/removing a trailing newline
// produces an exact diff rather than looking identical to an unchanged file.
function splitLineTokens(text) {
  if (text === null || text === undefined || text === '') return []
  const tokens = []
  let start = 0
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) {
      tokens.push(text.slice(start, i + 1))
      start = i + 1
    }
  }
  if (start < text.length) tokens.push(text.slice(start))
  return tokens
}

const tokenText = token => (token.endsWith('\n') ? token.slice(0, -1) : token)
const tokenNoNewline = token => !token.endsWith('\n')

function makeDiffRow(kind, token, nums, showNoNewline = false) {
  return {
    kind,
    ...nums,
    text: tokenText(token),
    ...(showNoNewline && kind !== 'ctx' && tokenNoNewline(token) ? { noNewline: true } : {}),
  }
}

// Bounded line diff: exact LCS for normal hunks, linear prefix/suffix fallback for huge inputs.
export function computeLineDiff(oldText, newText) {
  const before = oldText === null ? [] : splitLineTokens(oldText)
  const after = splitLineTokens(newText)
  const showNoNewline = oldText !== null && oldText.length > 0 && newText.length > 0
    && oldText.endsWith('\n') !== newText.endsWith('\n')
  if (before.length === 0 && after.length === 0) return { rows: [], added: 0, removed: 0 }
  if (before.length === 0) {
    return {
      rows: after.map((tok, index) => makeDiffRow('add', tok, { newNum: index + 1 })),
      added: after.length,
      removed: 0,
    }
  }
  if (after.length === 0) {
    return {
      rows: before.map((tok, index) => makeDiffRow('del', tok, { oldNum: index + 1 })),
      added: 0,
      removed: before.length,
    }
  }

  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix += 1

  const midBefore = before.slice(prefix, before.length - suffix)
  const midAfter = after.slice(prefix, after.length - suffix)
  const rows = []
  let added = 0
  let removed = 0

  for (let i = 0; i < prefix; i += 1) {
    rows.push(makeDiffRow('ctx', before[i], { oldNum: i + 1, newNum: i + 1 }))
  }

  if (midBefore.length === 0 && midAfter.length === 0) {
    // identical
  } else if (midBefore.length * midAfter.length <= MAX_LCS_CELLS) {
    const m = midBefore.length
    const n = midAfter.length
    const cols = n + 1
    const dp = new Int32Array((m + 1) * cols)
    for (let i = m - 1; i >= 0; i -= 1) {
      for (let j = n - 1; j >= 0; j -= 1) {
        dp[i * cols + j] = midBefore[i] === midAfter[j]
          ? dp[(i + 1) * cols + (j + 1)] + 1
          : Math.max(dp[(i + 1) * cols + j], dp[i * cols + (j + 1)])
      }
    }
    let i = 0
    let j = 0
    while (i < m && j < n) {
      if (midBefore[i] === midAfter[j]) {
        rows.push(makeDiffRow('ctx', midBefore[i], { oldNum: prefix + i + 1, newNum: prefix + j + 1 }))
        i += 1
        j += 1
      } else if (dp[(i + 1) * cols + j] >= dp[i * cols + (j + 1)]) {
        rows.push(makeDiffRow('del', midBefore[i], { oldNum: prefix + i + 1 }, showNoNewline))
        removed += 1
        i += 1
      } else {
        rows.push(makeDiffRow('add', midAfter[j], { newNum: prefix + j + 1 }, showNoNewline))
        added += 1
        j += 1
      }
    }
    while (i < m) {
      rows.push(makeDiffRow('del', midBefore[i], { oldNum: prefix + i + 1 }, showNoNewline))
      removed += 1
      i += 1
    }
    while (j < n) {
      rows.push(makeDiffRow('add', midAfter[j], { newNum: prefix + j + 1 }, showNoNewline))
      added += 1
      j += 1
    }
  } else {
    for (let i = 0; i < midBefore.length; i += 1) {
      rows.push(makeDiffRow('del', midBefore[i], { oldNum: prefix + i + 1 }, showNoNewline))
      removed += 1
    }
    for (let j = 0; j < midAfter.length; j += 1) {
      rows.push(makeDiffRow('add', midAfter[j], { newNum: prefix + j + 1 }, showNoNewline))
      added += 1
    }
  }

  for (let k = 0; k < suffix; k += 1) {
    const oldIdx = before.length - suffix + k
    const newIdx = after.length - suffix + k
    rows.push(makeDiffRow('ctx', before[oldIdx], { oldNum: oldIdx + 1, newNum: newIdx + 1 }))
  }

  return { rows, added, removed }
}

// Defensive narrowing of DSH `SearchMeta` (`@deepseek-ai/dsh-tool-fs-search`).
export function searchMetaFromMeta(meta) {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  if (typeof meta.truncated !== 'boolean' || typeof meta.total !== 'number') return undefined
  if (meta.shape === 'matches' && Array.isArray(meta.files)) {
    const files = []
    for (const file of meta.files) {
      if (typeof file !== 'object' || file === null || typeof file.path !== 'string' || !Array.isArray(file.matches)) return undefined
      const matches = []
      for (const match of file.matches) {
        if (typeof match !== 'object' || match === null || typeof match.lineNumber !== 'number' || typeof match.line !== 'string') return undefined
        matches.push({ lineNumber: match.lineNumber, line: match.line })
      }
      files.push({ path: file.path, matches })
    }
    return { shape: 'matches', files, truncated: meta.truncated, total: meta.total }
  }
  if (meta.shape === 'paths' && Array.isArray(meta.paths)) {
    if (!meta.paths.every(item => typeof item === 'string')) return undefined
    return { shape: 'paths', paths: meta.paths, truncated: meta.truncated, total: meta.total }
  }
  return undefined
}

// Defensive narrowing of DSH `WebSearchMeta` (`@deepseek-ai/dsh-tool-web`).
export function webSearchMetaFromMeta(meta) {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  if (!Array.isArray(meta.sources) || typeof meta.truncated !== 'boolean') return undefined
  const sources = []
  for (const src of meta.sources) {
    if (typeof src !== 'object' || src === null || typeof src.url !== 'string') return undefined
    sources.push({
      url: src.url,
      ...(typeof src.title === 'string' && src.title !== '' ? { title: src.title } : {}),
      ...(typeof src.snippet === 'string' && src.snippet !== '' ? { snippet: src.snippet } : {}),
      ...(typeof src.publishedAt === 'string' && src.publishedAt !== '' ? { publishedAt: src.publishedAt } : {}),
    })
  }
  return {
    sources,
    truncated: meta.truncated,
    ...(typeof meta.answer === 'string' && meta.answer !== '' ? { answer: meta.answer } : {}),
  }
}

// Defensive narrowing of DSH `WebFetchMeta` (`@deepseek-ai/dsh-tool-web`).
export function webFetchMetaFromMeta(meta) {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  if (typeof meta.url !== 'string' || typeof meta.statusCode !== 'number' || typeof meta.truncated !== 'boolean') return undefined
  return { url: meta.url, statusCode: meta.statusCode, truncated: meta.truncated }
}

export function parseTodoItems(block) {
  const raw = readArgValue(block, 'todos')
  if (!Array.isArray(raw)) return []
  const items = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || typeof item.content !== 'string') continue
    const status = item.status === 'completed' || item.status === 'in_progress' ? item.status : 'pending'
    items.push({ content: item.content, status })
  }
  return items
}

export function parsePresentedFiles(block) {
  const raw = readArgValue(block, 'files')
  if (!Array.isArray(raw)) return []
  const files = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || typeof item.path !== 'string' || item.path.trim() === '') continue
    files.push({
      path: item.path,
      ...(typeof item.description === 'string' && item.description.trim() !== '' ? { description: item.description.trim() } : {}),
    })
  }
  return files
}

function ShellToolView({ block, cwd, phase, useDisclosure, openFile, sessionId, feed, readOnly }) {
  const command = readArgText(block, 'command', 'cmd')
  const parsedOffice = useMemo(() => parseOfficeCliCommand(command), [command])
  const rawResult = useMemo(() => (phase === 'result' ? formatResult(block) : ''), [phase, block])
  const parsed = useMemo(() => (phase === 'result' ? parseExitStatus(rawResult) : null), [phase, rawResult])
  const bgJobId = useMemo(
    () => (phase === 'result' ? parseBackgroundJobIdFromShell(rawResult, block?.meta) : ''),
    [phase, rawResult, block?.meta],
  )
  const disclosure = useDisclosure(Boolean(bgJobId))
  const autoOpened = useRef(Boolean(bgJobId))
  useEffect(() => {
    if (!autoOpened.current && bgJobId) {
      autoOpened.current = true
      disclosure.setExpanded(true)
    }
  }, [bgJobId, disclosure])

  const runInBg = readArgValue(block, 'run_in_background') === true
  if (parsedOffice && !bgJobId && !runInBg) {
    return h(OfficeCliCard, {
      parsedCli: parsedOffice,
      command,
      block,
      cwd,
      workdir: readArgText(block, 'workdir'),
      phase,
      useDisclosure,
      openFile,
    })
  }

  const description = readArgText(block, 'description')
  const nonZero = parsed !== null && ('signal' in parsed || parsed.exitCode !== 0)
  const isError = phase === 'result' && (block?.isError === true || nonZero)
  const errLine = errorLineOf(block, block?.isError === true)
  const duration = formatToolDuration(block, phase)
  const badges = []
  if (bgJobId || runInBg) {
    badges.push(h('span', { key: 'bg', className: 'dsb-tool-pill' }, t('In background')))
  }
  if (parsed && 'signal' in parsed) {
    badges.push(h('span', { key: 'sig', className: 'dsb-tool-pill', 'data-tone': 'danger' }, t('signal {signal}', { signal: parsed.signal })))
  } else if (parsed && parsed.exitCode !== 0) {
    badges.push(h('span', { key: 'exit', className: 'dsb-tool-pill', 'data-tone': 'danger' }, t('exit {code}', { code: parsed.exitCode })))
  }
  const summary = description ? compact(description) : (command ? compact(`$ ${command}`) : '')
  const bodyText = parsed ? parsed.body : ''
  const hasBody = command !== '' || bodyText !== '' || errLine !== '' || bgJobId !== ''

  return h(ToolCardShell, {
    icon: TerminalIcon,
    label: t('Command'),
    summary,
    summaryTitle: command || description || undefined,
    badges,
    phase,
    isError,
    duration,
    expanded: disclosure.expanded,
    onToggle: disclosure.toggle,
    hasBody,
  },
  command !== '' ? h(CodeSection, { label: t('Command'), text: command }) : null,
  errLine !== '' ? h('div', { className: 'dsb-tool-errline', role: 'status' }, errLine) : null,
  bgJobId !== '' && sessionId
    ? h(BackgroundJobPanel, { sessionId, jobId: bgJobId, feed, readOnly, initialStatus: 'running' })
    : null,
  bodyText !== '' ? h(CodeSection, { label: t('Output'), text: bodyText, error: isError }) : null)
}

function ReadToolView({ block, cwd, phase, useDisclosure }) {
  const disclosure = useDisclosure()
  const [showAll, setShowAll] = useState(false)
  const isError = phase === 'result' && block?.isError === true
  const meta = useMemo(() => (phase === 'result' && !isError ? readMetaFromMeta(block?.meta) : undefined), [phase, isError, block?.meta])
  const rawPath = meta?.path ?? readArgText(block, 'file_path', 'path')
  const displayPath = shortPath(rawPath, cwd)
  const hasLines = meta !== undefined && meta.lines.length > 0
  const rawResult = useMemo(() => (phase === 'result' && !hasLines ? formatResult(block) : ''), [phase, hasLines, block])
  const errLine = errorLineOf(block, isError)
  const duration = formatToolDuration(block, phase)

  const badges = []
  if (hasLines) {
    const first = meta.lines[0].number
    const last = meta.lines.at(-1).number
    const range = first > 1 || last < meta.totalLines
      ? t('Lines {start}–{end} of {total}', { start: first, end: last, total: meta.totalLines })
      : `L${first}–${last}`
    badges.push(h('span', { key: 'range', className: 'dsb-tool-pill' }, range))
  }
  const hasBody = hasLines || rawResult !== '' || errLine !== ''
  const clipped = hasLines && meta.lines.length > READ_FOLD_LINES
  const visibleLines = hasLines ? (showAll || !clipped ? meta.lines : meta.lines.slice(0, READ_FOLD_LINES)) : []
  const rawCode = useMemo(() => (hasLines ? meta.lines.map(line => line.text).join('\n') : ''), [hasLines, meta])

  return h(ToolCardShell, {
    icon: FileIcon,
    label: t('Read file'),
    summary: displayPath,
    summaryTitle: rawPath || undefined,
    badges,
    phase,
    isError,
    duration,
    expanded: disclosure.expanded,
    onToggle: disclosure.toggle,
    hasBody,
  },
  errLine !== '' ? h('div', { className: 'dsb-tool-errline', role: 'status' }, errLine) : null,
  hasLines ? h('div', { className: 'dsb-code-box' },
    h('div', { className: 'dsb-code-head' },
      h('span', { className: 'dsb-code-path', title: rawPath }, displayPath),
      meta.lang ? h('span', { className: 'dsb-tool-pill' }, meta.lang) : null,
      h(MiniCopy, { text: rawCode })),
    h('div', { className: 'dsb-code-lines', role: 'region', 'aria-label': displayPath },
      visibleLines.map(line => h('div', { key: line.number, className: 'dsb-code-row' },
        h('span', { className: 'dsb-code-num', 'aria-hidden': true }, line.number),
        h('span', { className: 'dsb-code-text' }, line.text || '\u00a0')))),
    clipped ? h('button', {
      type: 'button',
      className: 'dsb-tool-fold',
      'aria-expanded': showAll,
      onClick: () => setShowAll(value => !value),
    }, showAll ? t('Show less') : t('Show all ({count} lines)', { count: meta.lines.length })) : null)
    : rawResult !== '' ? h(CodeSection, { label: isError ? t('Error') : t('Result'), text: rawResult, error: isError }) : null)
}

function ReadImageToolView({ block, cwd, phase, useDisclosure, openFile, loadImage }) {
  const imageBlocks = useMemo(
    () => (Array.isArray(block?.content) ? block.content.filter(item => item?.type === 'image' && item.attachment) : []),
    [block?.content],
  )
  const disclosure = useDisclosure(imageBlocks.length > 0)
  const autoOpened = useRef(imageBlocks.length > 0)
  useEffect(() => {
    if (!autoOpened.current && imageBlocks.length > 0) {
      autoOpened.current = true
      disclosure.setExpanded(true)
    }
  }, [imageBlocks.length, disclosure])
  const isError = phase === 'result' && block?.isError === true
  const rawPath = (typeof block?.meta?.path === 'string' && block.meta.path !== '' ? block.meta.path : '') || readArgText(block, 'file_path', 'path')
  const displayPath = shortPath(rawPath, cwd)
  const firstAttachment = imageBlocks[0]?.attachment
  const orig = firstAttachment?.originalDimensions
  const w = orig?.width ?? firstAttachment?.width
  const hgt = orig?.height ?? firstAttachment?.height
  const dims = Number.isFinite(w) && Number.isFinite(hgt) && w > 0 && hgt > 0 ? `${w}×${hgt}` : ''
  const size = Number.isFinite(firstAttachment?.bytes) && firstAttachment.bytes > 0 ? fileSizeText(firstAttachment.bytes) : ''
  const badges = []
  if (dims) badges.push(h('span', { key: 'dims', className: 'dsb-tool-pill' }, dims))
  if (size) badges.push(h('span', { key: 'size', className: 'dsb-tool-pill' }, size))
  const textOnlyResult = useMemo(() => {
    if (phase !== 'result') return ''
    if (imageBlocks.length === 0) return formatResult(block)
    return (Array.isArray(block?.content) ? block.content : [])
      .filter(item => item?.type === 'text' && typeof item.text === 'string' && item.text.trim() !== '')
      .map(item => item.text)
      .join('\n')
  }, [phase, imageBlocks.length, block])
  const errLine = errorLineOf(block, isError)
  const canPreview = typeof openFile === 'function' && rawPath !== '' && !isError && phase === 'result'
  const headerAction = canPreview
    ? h('button', {
      type: 'button',
      className: 'dsb-tool-action',
      title: rawPath,
      onClick: () => openFile(rawPath),
    }, t('Preview'))
    : null
  const hasBody = imageBlocks.length > 0 || textOnlyResult !== '' || errLine !== ''

  return h(ToolCardShell, {
    icon: ImageIcon,
    label: t('Read image'),
    summary: displayPath,
    summaryTitle: rawPath || undefined,
    badges,
    headerAction,
    phase,
    isError,
    duration: formatToolDuration(block, phase),
    expanded: disclosure.expanded,
    onToggle: disclosure.toggle,
    hasBody,
  },
  errLine !== '' ? h('div', { className: 'dsb-tool-errline', role: 'status' }, errLine) : null,
  imageBlocks.length > 0 ? h('div', { className: 'dsb-tool-shots' },
    imageBlocks.map((item, index) => h(ToolImageThumb, {
      key: item.attachment.attachmentId ?? index,
      attachment: item.attachment,
      loadImage,
      alt: displayPath || item.attachment.name || t('Image'),
      showMeta: false,
    }))) : null,
  textOnlyResult !== '' && (isError || imageBlocks.length === 0)
    ? h(CodeSection, { label: isError ? t('Error') : t('Result'), text: textOnlyResult, error: isError })
    : null)
}

function previewDiffsFromArgs(toolName, block) {
  const path = readArgText(block, 'file_path', 'path')
  if (toolName === 'edit' || toolName === 'edit_file') {
    const oldText = readArgText(block, 'old_string')
    const newText = readArgText(block, 'new_string')
    if (path && (oldText !== '' || newText !== '')) return [{ path, oldText, newText }]
  } else if (toolName === 'write' || toolName === 'write_file') {
    const newText = readArgText(block, 'content')
    if (path && newText !== '') return [{ path, oldText: null, newText }]
  } else if (toolName === 'str_replace_editor') {
    const oldText = readArgText(block, 'old_str')
    const newText = readArgText(block, 'new_str', 'file_text')
    if (path && (oldText !== '' || newText !== '')) return [{ path, oldText: oldText || null, newText }]
  }
  return []
}

function patchPathsFromArg(patchText) {
  if (typeof patchText !== 'string' || patchText === '') return []
  const paths = []
  for (const match of patchText.matchAll(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/gm)) {
    const p = match[1]?.trim()
    if (p) paths.push(p)
  }
  return paths
}

function DiffFileView({ diff, computed, cwd }) {
  const [showAll, setShowAll] = useState(false)
  const displayPath = shortPath(diff.path, cwd)
  const clipped = computed.rows.length > DIFF_FOLD_LINES
  const visible = showAll || !clipped ? computed.rows : computed.rows.slice(0, DIFF_FOLD_LINES)
  const unifiedText = useMemo(
    () => computed.rows.flatMap(row => [
      `${row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}${row.text}`,
      ...(row.noNewline ? ['\\ No newline at end of file'] : []),
    ]).join('\n'),
    [computed.rows],
  )
  return h('div', { className: 'dsb-diff-file' },
    h('div', { className: 'dsb-diff-head' },
      h('span', { className: 'dsb-code-path', title: diff.path }, displayPath),
      computed.added > 0 ? h('span', { className: 'dsb-diff-plus' }, `+${computed.added}`) : null,
      computed.removed > 0 ? h('span', { className: 'dsb-diff-minus' }, `-${computed.removed}`) : null,
      unifiedText !== '' ? h(MiniCopy, { text: unifiedText }) : null),
    visible.length > 0 ? h('div', { className: 'dsb-diff-lines' },
      visible.flatMap((row, index) => [
        h('div', { key: `${index}:l`, className: 'dsb-diff-row', 'data-kind': row.kind },
          h('span', { className: 'dsb-diff-num', 'aria-hidden': true }, row.kind === 'del' ? row.oldNum : (row.newNum ?? '')),
          h('span', { className: 'dsb-diff-sign', 'aria-hidden': true }, row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '),
          h('span', { className: 'dsb-diff-text' }, row.text || '\u00a0')),
        ...(row.noNewline ? [h('div', { key: `${index}:nnl`, className: 'dsb-diff-row dsb-diff-note', 'data-kind': row.kind },
          h('span', { className: 'dsb-diff-num', 'aria-hidden': true }, ''),
          h('span', { className: 'dsb-diff-sign', 'aria-hidden': true }, '\\'),
          h('span', { className: 'dsb-diff-text' }, t('No newline at end of file')))] : []),
      ])) : null,
    clipped ? h('button', {
      type: 'button',
      className: 'dsb-tool-fold',
      'aria-expanded': showAll,
      onClick: () => setShowAll(value => !value),
    }, showAll ? t('Show less') : t('Show all ({count} lines)', { count: computed.rows.length })) : null)
}

function DiffToolView({ toolName, block, cwd, phase, useDisclosure }) {
  const disclosure = useDisclosure()
  const isError = phase === 'result' && block?.isError === true
  const meta = useMemo(() => (phase === 'result' && !isError ? diffMetaFromMeta(block?.meta) : undefined), [phase, isError, block?.meta])
  const diffs = useMemo(() => (meta?.diffs?.length ? meta.diffs : previewDiffsFromArgs(toolName, block)), [meta, toolName, block])
  // DSH `apply_patch` uses `input` for the patch payload; fall back to `patch` for compatibility.
  const patchArg = toolName === 'apply_patch' ? readArgText(block, 'input', 'patch') : ''
  const patchPaths = useMemo(() => (diffs.length === 0 ? patchPathsFromArg(patchArg) : []), [diffs.length, patchArg])
  const computedDiffs = useMemo(
    () => diffs.map(diff => ({ diff, computed: computeLineDiff(diff.oldText, diff.newText) })),
    [diffs],
  )
  const totals = useMemo(() => {
    let added = 0
    let removed = 0
    for (const { computed } of computedDiffs) {
      added += computed.added
      removed += computed.removed
    }
    return { added, removed }
  }, [computedDiffs])

  const label = toolName === 'write' || toolName === 'write_file' ? t('Write')
    : toolName === 'apply_patch' ? t('Patch')
      : t('Edit')
  const rawPrimary = meta?.path ?? diffs[0]?.path ?? patchPaths[0] ?? readArgText(block, 'file_path', 'path')
  const extraCount = Math.max(diffs.length, patchPaths.length) - 1
  const summary = rawPrimary
    ? `${shortPath(rawPrimary, cwd)}${extraCount > 0 ? ` (+${extraCount})` : ''}`
    : ''

  const badges = []
  if (meta?.operation === 'create') badges.push(h('span', { key: 'op', className: 'dsb-tool-pill', 'data-tone': 'ok' }, t('Created')))
  if (meta?.stopped) badges.push(h('span', { key: 'stop', className: 'dsb-tool-pill', 'data-tone': 'warn' }, t('Stopped')))
  if (totals.added > 0) badges.push(h('span', { key: 'add', className: 'dsb-diff-plus' }, `+${totals.added}`))
  if (totals.removed > 0) badges.push(h('span', { key: 'del', className: 'dsb-diff-minus' }, `-${totals.removed}`))

  // Always preserve returned diagnostics on failed edits/writes even when preview diffs exist.
  const rawResult = phase === 'result' && (!meta || isError) ? formatResult(block) : ''
  const errLine = errorLineOf(block, isError)
  const hasBody = computedDiffs.length > 0 || patchArg !== '' || rawResult !== '' || errLine !== ''

  return h(ToolCardShell, {
    icon: DiffIcon,
    label,
    summary,
    summaryTitle: rawPrimary || undefined,
    badges,
    phase,
    isError,
    duration: formatToolDuration(block, phase),
    expanded: disclosure.expanded,
    onToggle: disclosure.toggle,
    hasBody,
  },
  errLine !== '' ? h('div', { className: 'dsb-tool-errline', role: 'status' }, errLine) : null,
  rawResult !== '' && isError ? h(CodeSection, { label: t('Error'), text: rawResult, error: true }) : null,
  computedDiffs.length > 0
    ? computedDiffs.map(({ diff, computed }, index) => h(DiffFileView, { key: `${diff.path}:${index}`, diff, computed, cwd }))
    : patchArg !== '' ? h(CodeSection, { label: t('Patch'), text: patchArg }) : null,
  rawResult !== '' && !isError ? h(CodeSection, { label: t('Result'), text: rawResult, error: false }) : null)
}

function SearchToolView({ toolName, block, cwd, phase, useDisclosure }) {
  const disclosure = useDisclosure()
  const [showAll, setShowAll] = useState(false)
  const isError = phase === 'result' && block?.isError === true
  const meta = useMemo(() => (phase === 'result' && !isError ? searchMetaFromMeta(block?.meta) : undefined), [phase, isError, block?.meta])
  const pattern = readArgText(block, 'pattern', 'query')
  const searchPath = readArgText(block, 'path')
  const summary = pattern
    ? (searchPath ? `${compact(pattern, 64)} · ${shortPath(searchPath, cwd)}` : compact(pattern))
    : shortPath(searchPath, cwd)

  const badges = []
  if (meta?.shape === 'matches') {
    badges.push(h('span', { key: 'cnt', className: 'dsb-tool-pill' },
      meta.total === 0 ? t('No matches') : t('{count} matches', { count: meta.total })))
  } else if (meta?.shape === 'paths') {
    badges.push(h('span', { key: 'cnt', className: 'dsb-tool-pill' },
      meta.total === 0 ? t('No files') : t('{count} files', { count: meta.total })))
  }
  if (meta?.truncated) {
    badges.push(h('span', { key: 'trunc', className: 'dsb-tool-pill', 'data-tone': 'warn' }, t('Truncated')))
  }

  const rawResult = phase === 'result' && !meta ? formatResult(block) : ''
  const errLine = errorLineOf(block, isError)
  const flatMatches = useMemo(() => {
    if (meta?.shape !== 'matches') return []
    const out = []
    for (const file of meta.files) {
      for (const match of file.matches) out.push({ path: file.path, lineNumber: match.lineNumber, line: match.line })
    }
    return out
  }, [meta])
  const totalItems = meta?.shape === 'matches' ? flatMatches.length : (meta?.shape === 'paths' ? meta.paths.length : 0)
  const clipped = totalItems > SEARCH_FOLD_ITEMS
  const hasBody = totalItems > 0 || rawResult !== '' || errLine !== ''

  return h(ToolCardShell, {
    icon: toolName === 'glob' ? FolderIcon : SearchIcon,
    label: toolName === 'glob' ? t('Files') : t('Search'),
    summary,
    summaryTitle: pattern || undefined,
    badges,
    phase,
    isError,
    duration: formatToolDuration(block, phase),
    expanded: disclosure.expanded,
    onToggle: disclosure.toggle,
    hasBody,
  },
  errLine !== '' ? h('div', { className: 'dsb-tool-errline', role: 'status' }, errLine) : null,
  meta?.shape === 'matches' && flatMatches.length > 0 ? h('div', { className: 'dsb-search-list' },
    (showAll || !clipped ? flatMatches : flatMatches.slice(0, SEARCH_FOLD_ITEMS)).map((item, index) => h('div', { key: index, className: 'dsb-search-match' },
      h('span', { className: 'dsb-search-loc', title: item.path }, `${shortPath(item.path, cwd)}:${item.lineNumber}`),
      h('span', { className: 'dsb-search-line' }, item.line.trim()))),
    clipped ? h('button', {
      type: 'button',
      className: 'dsb-tool-fold',
      'aria-expanded': showAll,
      onClick: () => setShowAll(value => !value),
    }, showAll ? t('Show less') : t('Show all ({count} lines)', { count: flatMatches.length })) : null) : null,
  meta?.shape === 'paths' && meta.paths.length > 0 ? h('div', { className: 'dsb-search-list' },
    (showAll || !clipped ? meta.paths : meta.paths.slice(0, SEARCH_FOLD_ITEMS)).map((filePath, index) => h('div', { key: index, className: 'dsb-search-path', title: filePath }, shortPath(filePath, cwd))),
    clipped ? h('button', {
      type: 'button',
      className: 'dsb-tool-fold',
      'aria-expanded': showAll,
      onClick: () => setShowAll(value => !value),
    }, showAll ? t('Show less') : t('Show all ({count} lines)', { count: meta.paths.length })) : null) : null,
  rawResult !== '' ? h(CodeSection, { label: isError ? t('Error') : t('Result'), text: rawResult, error: isError }) : null)
}

function WebSearchToolView({ block, phase, useDisclosure }) {
  const disclosure = useDisclosure()
  const isError = phase === 'result' && block?.isError === true
  const meta = useMemo(() => (phase === 'result' && !isError ? webSearchMetaFromMeta(block?.meta) : undefined), [phase, isError, block?.meta])
  const queries = readArgValue(block, 'queries')
  const querySummary = Array.isArray(queries) && queries.length > 0
    ? compact(queries.filter(item => typeof item === 'string').join(', '))
    : compact(readArgText(block, 'query'))
  const badges = []
  if (meta) {
    badges.push(h('span', { key: 'cnt', className: 'dsb-tool-pill' }, t('{count} results', { count: meta.sources.length })))
    if (meta.truncated) badges.push(h('span', { key: 'trunc', className: 'dsb-tool-pill', 'data-tone': 'warn' }, t('Truncated')))
  }
  const rawResult = phase === 'result' && !meta ? formatResult(block) : ''
  const errLine = errorLineOf(block, isError)
  const hasBody = Boolean(meta && (meta.sources.length > 0 || meta.answer)) || rawResult !== '' || errLine !== ''

  return h(ToolCardShell, {
    icon: GlobeIcon,
    label: t('Web search'),
    summary: querySummary,
    badges,
    phase,
    isError,
    duration: formatToolDuration(block, phase),
    expanded: disclosure.expanded,
    onToggle: disclosure.toggle,
    hasBody,
  },
  errLine !== '' ? h('div', { className: 'dsb-tool-errline', role: 'status' }, errLine) : null,
  meta?.answer ? h('div', { className: 'dsb-web-answer' }, meta.answer) : null,
  meta?.sources?.length > 0 ? h('div', { className: 'dsb-web-sources' },
    meta.sources.map((src, index) => {
      const safe = safeWebHref(src.url)
      const head = h('span', { className: 'dsb-web-src-title' }, src.title || safe?.host || src.url)
      const host = safe ? h('span', { className: 'dsb-web-src-host' }, safe.host) : null
      return h('div', { key: index, className: 'dsb-web-src' },
        safe
          ? h('a', { className: 'dsb-web-link', href: safe.href, target: '_blank', rel: 'noopener noreferrer' }, head, host)
          : h('div', { className: 'dsb-web-link' }, head),
        src.snippet ? h('p', { className: 'dsb-web-snippet' }, src.snippet) : null)
    })) : null,
  rawResult !== '' ? h(CodeSection, { label: isError ? t('Error') : t('Results'), text: rawResult, error: isError }) : null)
}

function WebFetchToolView({ block, phase, useDisclosure }) {
  const disclosure = useDisclosure()
  const isError = phase === 'result' && block?.isError === true
  const meta = useMemo(() => (phase === 'result' && !isError ? webFetchMetaFromMeta(block?.meta) : undefined), [phase, isError, block?.meta])
  const url = meta?.url ?? readArgText(block, 'url')
  const safe = safeWebHref(url)
  const badges = []
  if (meta) {
    const tone = meta.statusCode >= 400 ? 'danger' : meta.statusCode >= 300 ? 'warn' : 'ok'
    badges.push(h('span', { key: 'code', className: 'dsb-tool-pill', 'data-tone': tone }, String(meta.statusCode)))
    if (meta.truncated) badges.push(h('span', { key: 'trunc', className: 'dsb-tool-pill', 'data-tone': 'warn' }, t('Truncated')))
  }
  const rawResult = phase === 'result' ? formatResult(block) : ''
  const errLine = errorLineOf(block, isError)
  const hasBody = safe !== null || rawResult !== '' || errLine !== ''

  return h(ToolCardShell, {
    icon: GlobeIcon,
    label: t('Web fetch'),
    summary: safe ? compact(safe.display) : compact(url),
    summaryTitle: url || undefined,
    badges,
    phase,
    isError,
    duration: formatToolDuration(block, phase),
    expanded: disclosure.expanded,
    onToggle: disclosure.toggle,
    hasBody,
  },
  errLine !== '' ? h('div', { className: 'dsb-tool-errline', role: 'status' }, errLine) : null,
  safe ? h('a', { className: 'dsb-web-url', href: safe.href, target: '_blank', rel: 'noopener noreferrer' }, safe.href) : null,
  rawResult !== '' ? h(CodeSection, { label: isError ? t('Error') : t('Output'), text: rawResult, error: isError }) : null)
}

function TodoToolView({ block, phase, useDisclosure }) {
  const items = useMemo(() => parseTodoItems(block), [block])
  // Start open regardless of initial readiness so live preparing->start streams expand cleanly.
  const disclosure = useDisclosure(true)
  const isError = phase === 'result' && block?.isError === true
  const done = items.filter(item => item.status === 'completed').length
  const active = items.find(item => item.status === 'in_progress')
  const badges = items.length > 0
    ? [h('span', { key: 'prog', className: 'dsb-tool-pill', 'data-tone': done === items.length ? 'ok' : undefined }, t('{done} / {total}', { done, total: items.length }))]
    : []
  const errLine = errorLineOf(block, isError)
  const hasBody = items.length > 0 || errLine !== ''

  return h(ToolCardShell, {
    icon: ListCheckIcon,
    label: t('Tasks'),
    summary: active ? compact(active.content) : '',
    badges,
    phase,
    isError,
    duration: formatToolDuration(block, phase),
    expanded: disclosure.expanded,
    onToggle: disclosure.toggle,
    hasBody,
  },
  errLine !== '' ? h('div', { className: 'dsb-tool-errline', role: 'status' }, errLine) : null,
  items.length > 0 ? h('ul', { className: 'dsb-todo-list' },
    items.map((item, index) => h('li', { key: index, className: 'dsb-todo-item', 'data-status': item.status },
      h('span', { className: 'dsb-todo-mark', 'aria-hidden': true },
        item.status === 'completed' ? h(CheckIcon) : null),
      h('span', { className: 'dsb-todo-text' }, item.content)))) : null)
}

function PresentToolView({ block, cwd, phase, useDisclosure }) {
  const files = useMemo(() => parsePresentedFiles(block), [block])
  const disclosure = useDisclosure(true)
  const isError = phase === 'result' && block?.isError === true
  const errLine = errorLineOf(block, isError)
  const badges = files.length > 0
    ? [h('span', { key: 'cnt', className: 'dsb-tool-pill' }, t('{count} files', { count: files.length }))]
    : []
  const summary = files.length > 0 ? shortPath(files[0].path, cwd) : ''
  const hasBody = files.length > 0 || errLine !== ''

  return h(ToolCardShell, {
    icon: FileIcon,
    label: t('Deliverables'),
    summary,
    summaryTitle: files[0]?.path || undefined,
    badges,
    phase,
    isError,
    duration: formatToolDuration(block, phase),
    expanded: disclosure.expanded,
    onToggle: disclosure.toggle,
    hasBody,
  },
  errLine !== '' ? h('div', { className: 'dsb-tool-errline', role: 'status' }, errLine) : null,
  files.length > 0 ? h('div', { className: 'dsb-present-list' },
    files.map((file, index) => {
      const display = shortPath(file.path, cwd)
      const name = display.split('/').pop() || display
      return h('div', { key: index, className: 'dsb-present-item', title: file.path },
        h('span', { className: 'dsb-present-icon', 'aria-hidden': true }, h(FileIcon)),
        h('div', { className: 'dsb-present-meta' },
          h('span', { className: 'dsb-present-name' }, name),
          display !== name ? h('span', { className: 'dsb-present-path' }, display) : null,
          file.description ? h('span', { className: 'dsb-present-desc' }, file.description) : null))
    })) : null)
}

function RunCodeToolView({ block, phase, useDisclosure }) {
  const disclosure = useDisclosure()
  const isError = phase === 'result' && block?.isError === true
  const description = readArgText(block, 'description')
  const code = readArgText(block, 'code', 'script')
  const firstLine = code.split('\n').map(line => line.trim()).find(line => line !== '' && !line.startsWith('//') && !line.startsWith('#')) ?? ''
  const rawResult = phase === 'result' ? formatResult(block) : ''
  const errLine = errorLineOf(block, isError)
  const hasBody = code !== '' || rawResult !== '' || errLine !== ''

  return h(ToolCardShell, {
    icon: CodeIcon,
    label: t('Run code'),
    summary: compact(description || firstLine),
    phase,
    isError,
    duration: formatToolDuration(block, phase),
    expanded: disclosure.expanded,
    onToggle: disclosure.toggle,
    hasBody,
  },
  code !== '' ? h(CodeSection, { label: t('Run code'), text: code }) : null,
  errLine !== '' ? h('div', { className: 'dsb-tool-errline', role: 'status' }, errLine) : null,
  rawResult !== '' ? h(CodeSection, { label: isError ? t('Error') : t('Output'), text: rawResult, error: isError }) : null)
}

function makeSimpleToolView({ icon, label, summaryOf }) {
  return function SimpleToolView({ toolName, block, cwd, phase, useDisclosure }) {
    const disclosure = useDisclosure()
    const isError = phase === 'result' && block?.isError === true
    const summary = summaryOf ? summaryOf(block, cwd, toolName) : argSummary(block?.args)
    const argsText = useMemo(() => formatArgs(block), [block])
    const rawResult = phase === 'result' ? formatResult(block) : ''
    const errLine = errorLineOf(block, isError)
    const hasBody = argsText !== '' || rawResult !== '' || errLine !== ''

    return h(ToolCardShell, {
      icon,
      label: t(label),
      summary,
      phase,
      isError,
      duration: formatToolDuration(block, phase),
      expanded: disclosure.expanded,
      onToggle: disclosure.toggle,
      hasBody,
    },
    argsText !== '' ? h(CodeSection, { label: t('Arguments'), text: argsText }) : null,
    errLine !== '' ? h('div', { className: 'dsb-tool-errline', role: 'status' }, errLine) : null,
    rawResult !== '' ? h(CodeSection, { label: isError ? t('Error') : t('Result'), text: rawResult, error: isError }) : null)
  }
}

const SkillToolView = makeSimpleToolView({
  icon: BlocksIcon,
  label: 'Skill',
  summaryOf: block => compact(readArgText(block, 'name', 'skill') || argSummary(block?.args)),
})

const WorkingDirectoryToolView = makeSimpleToolView({
  icon: FolderIcon,
  label: 'Working directory',
  summaryOf: (block, cwd) => shortPath(readArgText(block, 'cd', 'path', 'cwd', 'directory'), cwd),
})

const BUILTIN_VIEWS = [
  ['bash', ShellToolView],
  ['pwsh', ShellToolView],
  ['read', ReadToolView],
  ['read_file', ReadToolView],
  ['read_image', ReadImageToolView],
  ['edit', DiffToolView],
  ['edit_file', DiffToolView],
  ['write', DiffToolView],
  ['write_file', DiffToolView],
  ['apply_patch', DiffToolView],
  ['str_replace_editor', DiffToolView],
  ['grep', SearchToolView],
  ['glob', SearchToolView],
  ['web_search', WebSearchToolView],
  ['web_fetch', WebFetchToolView],
  ['todo_write', TodoToolView],
  ['present', PresentToolView],
  ['run_code', RunCodeToolView],
  ['skill', SkillToolView],
  ['working_directory', WorkingDirectoryToolView],
  ...OFFICE_TOOL_NAMES.map(name => [name, OfficeToolView]),
  ...BROWSER_TOOL_NAMES.map(name => [name, BrowserToolView]),
  ['cua', ComputerToolView],
  ['computer_handoff', ComputerToolView],
  ...JOB_TOOL_NAMES.map(name => [name, JobToolView]),
  ...SUBAGENT_TOOL_NAMES.map(name => [name, SubagentToolView]),
]

/**
 * Registers DS Bot's built-in DSH tool views into `tool.call.toolview` at priority 100
 * (so plugin views registered at default priority 0 take precedence). Returns a disposer.
 */
export function registerBuiltinToolViews(registry = defaultSlots) {
  const offs = BUILTIN_VIEWS.map(([key, component]) => registry.register({
    name: TOOL_VIEW_SLOT,
    key,
    priority: BUILTIN_TOOL_PRIORITY,
  }, component))
  return () => {
    for (const off of offs) off()
  }
}
