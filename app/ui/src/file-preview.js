// Multi-format document previewer for the workspace right panel:
// Markdown, virtualized code/text with line numbers and word-wrap toggle, CSV/TSV
// spreadsheet tables, Excel workbooks, zoomable images & SVG, zoomable PDF (and
// libreoffice-kit converted Office documents), strictly sandboxed HTML, and live
// file-change reload / auto-refresh controls.
import { createElement as h, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fileSizeText, MarkdownText, writeClipboard } from '../../../ds-bot/src/client/dsh-primitives.js'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { CheckIcon, CopyIcon, DownloadIcon, FileIcon } from '../../../ds-bot/src/client/icons.js'
import { renderTokenList, useHighlightedLines } from './code-highlight.js'
import { prepareHtmlPreview } from './html-preview.js'

const MAX_TABLE_ROWS = 500
const MAX_TABLE_COLS = 64
const CODE_LINE_HEIGHT = 19
const CODE_VIRTUAL_THRESHOLD = 200
const CODE_OVERSCAN = 24
const DEFAULT_VIEWPORT_HEIGHT = 600
const DEFAULT_VIEWPORT_WIDTH = 420
const WRAP_STORAGE_KEY = 'dsb.preview.wrap'
const IMAGE_ZOOM_STEPS = [25, 50, 75, 100, 125, 150, 200, 300, 400]
const PDF_ZOOM_STEPS = [50, 75, 100, 125, 150, 200, 300]

const WrapIcon = () => h('svg', {
  width: 15, height: 15, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
},
h('path', { d: 'M3.5 5.5h13' }),
h('path', { d: 'M3.5 10h10a2.5 2.5 0 0 1 0 5H10' }),
h('path', { d: 'M12 13l-2 2 2 2' }),
h('path', { d: 'M3.5 14.5h3.5' }))

const MinusIcon = () => h('svg', {
  width: 14, height: 14, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.7, strokeLinecap: 'round', 'aria-hidden': true,
}, h('path', { d: 'M4.5 10h11' }))

const PlusSmallIcon = () => h('svg', {
  width: 14, height: 14, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.7, strokeLinecap: 'round', 'aria-hidden': true,
}, h('path', { d: 'M10 4.5v11M4.5 10h11' }))

const RefreshSmallIcon = () => h('svg', {
  width: 14, height: 14, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
}, h('path', { d: 'M15.5 10a5.5 5.5 0 1 1-1.6-3.9' }), h('path', { d: 'M15.5 3.5v3.5H12' }))

function readSavedWrap() {
  try { return globalThis.localStorage?.getItem(WRAP_STORAGE_KEY) === '1' } catch { return false }
}

function writeSavedWrap(value) {
  try { globalThis.localStorage?.setItem(WRAP_STORAGE_KEY, value ? '1' : '0') } catch { /* ignore storage errors */ }
}

/**
 * Parses RFC 4180 CSV or TSV text into bounded rows for table rendering.
 * @param {string} text
 * @param {string} [delimiter=',']
 * @param {number} [maxRows=500]
 * @returns {{ headers: string[], rows: string[][], truncatedRows: boolean }}
 */
export function parseDelimitedTable(text, delimiter = ',', maxRows = MAX_TABLE_ROWS) {
  const src = typeof text === 'string' ? text.replace(/^\uFEFF/, '') : ''
  if (src === '') return { headers: [], rows: [], truncatedRows: false }
  const parsed = []
  let row = []
  let field = ''
  let inQuotes = false
  let hasRecordContent = false
  let truncatedRows = false
  const pushRow = () => {
    if (parsed.length > maxRows) {
      truncatedRows = true
      return false
    }
    parsed.push(row)
    row = []
    field = ''
    hasRecordContent = false
    return true
  }
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"' && field === '') {
      inQuotes = true
      hasRecordContent = true
      continue
    }
    if (ch === delimiter) {
      hasRecordContent = true
      if (row.length < MAX_TABLE_COLS) row.push(field)
      field = ''
      continue
    }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1
      if (hasRecordContent || row.length > 0 || field !== '') {
        if (row.length < MAX_TABLE_COLS) row.push(field)
        if (!pushRow()) break
      }
      continue
    }
    hasRecordContent = true
    field += ch
  }
  if (!truncatedRows && (hasRecordContent || row.length > 0 || field !== '')) {
    if (row.length < MAX_TABLE_COLS) row.push(field)
    pushRow()
  }
  if (parsed.length === 0) return { headers: [], rows: [], truncatedRows: false }
  const headers = parsed[0]
  const rows = parsed.slice(1, maxRows + 1)
  return { headers, rows, truncatedRows }
}

function base64ToBlobUrl(base64, mime) {
  if (!base64 || typeof URL?.createObjectURL !== 'function') return null
  try {
    let bytes
    if (typeof base64 === 'string' && typeof Uint8Array.fromBase64 === 'function') {
      bytes = Uint8Array.fromBase64(base64)
    } else {
      if (typeof globalThis.atob !== 'function') return null
      const binary = globalThis.atob(base64)
      bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    }
    return URL.createObjectURL(new Blob([bytes], { type: mime }))
  } catch {
    return null
  }
}

function useBlobUrl(base64, mime) {
  const [url, setUrl] = useState(null)
  useEffect(() => {
    const next = base64ToBlobUrl(base64, mime)
    setUrl(next)
    return () => {
      if (next && typeof URL?.revokeObjectURL === 'function') URL.revokeObjectURL(next)
    }
  }, [base64, mime])
  return url
}

function findOffsetIndex(offsets, y) {
  let lo = 0
  let hi = offsets.length - 2
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (offsets[mid + 1] <= y) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Computes the visible line slice and top/bottom spacer heights for virtualized code rendering.
 */
export function computeCodeWindow({
  lineCount,
  scrollTop = 0,
  viewportHeight = DEFAULT_VIEWPORT_HEIGHT,
  lineHeight = CODE_LINE_HEIGHT,
  overscan = CODE_OVERSCAN,
  offsets = null,
}) {
  if (lineCount <= 0) return { start: 0, end: 0, topPad: 0, bottomPad: 0, totalHeight: 0 }
  const vh = viewportHeight > 0 ? viewportHeight : DEFAULT_VIEWPORT_HEIGHT
  const st = Math.max(0, scrollTop)
  if (offsets && offsets.length === lineCount + 1) {
    const totalHeight = offsets[lineCount]
    const first = findOffsetIndex(offsets, st)
    const last = findOffsetIndex(offsets, st + vh)
    const start = Math.max(0, first - overscan)
    const end = Math.min(lineCount, last + 1 + overscan)
    return {
      start,
      end,
      topPad: offsets[start],
      bottomPad: Math.max(0, totalHeight - offsets[end]),
      totalHeight,
    }
  }
  const totalHeight = lineCount * lineHeight
  const first = Math.floor(st / lineHeight)
  const last = Math.ceil((st + vh) / lineHeight)
  const start = Math.max(0, first - overscan)
  const end = Math.min(lineCount, last + overscan)
  return {
    start,
    end,
    topPad: start * lineHeight,
    bottomPad: Math.max(0, (lineCount - end) * lineHeight),
    totalHeight,
  }
}

function computeTargetScrollTop({ targetLine, lineCount, isVirtualized, wrapOffsets, viewportHeight }) {
  if (!isVirtualized || !Number.isInteger(targetLine) || targetLine <= 0 || targetLine > lineCount) return 0
  const idx = targetLine - 1
  const lineY = wrapOffsets ? wrapOffsets[idx] : idx * CODE_LINE_HEIGHT
  return Math.max(0, Math.round(lineY - viewportHeight / 2))
}

function CodeLines({ text, language = '', targetLine = null, wordWrap = false, fileKey = '' }) {
  const source = String(text ?? '')
  const fileScope = fileKey || source
  const lines = useMemo(() => source.split(/\r?\n/), [source])
  const highlighted = useHighlightedLines(source, language)
  const wrapRef = useRef(null)
  const targetRef = useRef(null)
  const [viewport, setViewport] = useState({ height: DEFAULT_VIEWPORT_HEIGHT, width: DEFAULT_VIEWPORT_WIDTH })

  const isVirtualized = lines.length > CODE_VIRTUAL_THRESHOLD

  const wrapOffsets = useMemo(() => {
    if (!isVirtualized || !wordWrap) return null
    const charsPerLine = Math.max(20, Math.floor((viewport.width - 72) / 7.4))
    const offsets = new Float64Array(lines.length + 1)
    let y = 0
    for (let i = 0; i < lines.length; i += 1) {
      offsets[i] = y
      const wrappedRows = Math.max(1, Math.ceil(Math.max(1, lines[i].length) / charsPerLine))
      y += wrappedRows * CODE_LINE_HEIGHT
    }
    offsets[lines.length] = y
    return offsets
  }, [isVirtualized, wordWrap, lines, viewport.width])

  const [scrollTop, setScrollTop] = useState(() => computeTargetScrollTop({
    targetLine,
    lineCount: lines.length,
    isVirtualized,
    wrapOffsets,
    viewportHeight: viewport.height,
  }))
  const prevFileScopeRef = useRef(fileScope)
  const jumpedKeyRef = useRef(null)
  const linesLengthRef = useRef(lines.length)
  linesLengthRef.current = lines.length
  const wrapOffsetsRef = useRef(wrapOffsets)
  wrapOffsetsRef.current = wrapOffsets
  const viewportHeightRef = useRef(viewport.height)
  viewportHeightRef.current = viewport.height

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return undefined
    const measure = () => {
      const nextH = el.clientHeight > 0 ? el.clientHeight : DEFAULT_VIEWPORT_HEIGHT
      const nextW = el.clientWidth > 0 ? el.clientWidth : DEFAULT_VIEWPORT_WIDTH
      setViewport(cur => (cur.height === nextH && cur.width === nextW ? cur : { height: nextH, width: nextW }))
    }
    measure()
    if (typeof ResizeObserver !== 'function') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [fileScope])

  // Jump at most once per unique `(fileScope, targetLine)` so subsequent user scrolling,
  // viewport resizes, and word-wrap toggles stay at the user's current scroll position.
  useEffect(() => {
    const fileChanged = prevFileScopeRef.current !== fileScope
    prevFileScopeRef.current = fileScope
    const lineCount = linesLengthRef.current
    const hasTarget = Number.isInteger(targetLine) && targetLine > 0 && targetLine <= lineCount
    if (!hasTarget) {
      jumpedKeyRef.current = null
      if (fileChanged) {
        if (wrapRef.current) wrapRef.current.scrollTop = 0
        setScrollTop(0)
      }
      return
    }
    const jumpKey = `${fileScope}\0${targetLine}`
    if (jumpedKeyRef.current === jumpKey) return
    jumpedKeyRef.current = jumpKey
    if (isVirtualized) {
      const el = wrapRef.current
      const vh = el && el.clientHeight > 0 ? el.clientHeight : viewportHeightRef.current
      const nextScroll = computeTargetScrollTop({
        targetLine,
        lineCount,
        isVirtualized: true,
        wrapOffsets: wrapOffsetsRef.current,
        viewportHeight: vh,
      })
      if (el) el.scrollTop = nextScroll
      setScrollTop(nextScroll)
    } else {
      targetRef.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
    }
  }, [fileScope, targetLine, isVirtualized])

  const onScroll = useCallback((event) => {
    if (!isVirtualized) return
    const el = event.currentTarget
    const next = Math.max(0, el?.scrollTop ?? 0)
    setScrollTop((cur) => {
      if (cur === next) return cur
      if (next === 0 || Math.abs(cur - next) >= CODE_LINE_HEIGHT) return next
      if (el && Number.isFinite(el.scrollHeight) && Number.isFinite(el.clientHeight) && el.scrollHeight > 0 && next + el.clientHeight >= el.scrollHeight - 1) {
        return next
      }
      return cur
    })
  }, [isVirtualized])

  const { start, end, topPad, bottomPad } = isVirtualized
    ? computeCodeWindow({
      lineCount: lines.length,
      scrollTop,
      viewportHeight: viewport.height,
      lineHeight: CODE_LINE_HEIGHT,
      overscan: CODE_OVERSCAN,
      offsets: wrapOffsets,
    })
    : { start: 0, end: lines.length, topPad: 0, bottomPad: 0 }

  const visibleRows = []
  if (topPad > 0) {
    visibleRows.push(h('tr', { key: 'pad-top', className: 'dsb-pv-spacer', 'aria-hidden': true },
      h('td', { colSpan: 2, style: { height: `${topPad}px`, padding: 0, border: 0 } })))
  }
  for (let idx = start; idx < end; idx += 1) {
    const lineNum = idx + 1
    const isTarget = targetLine === lineNum
    const tokens = highlighted?.[idx]
    const content = tokens && tokens.length > 0 ? renderTokenList(tokens, `l${idx}`) : (lines[idx] || '\u00a0')
    visibleRows.push(h('tr', {
      key: idx,
      ref: isTarget ? targetRef : undefined,
      'data-line': lineNum,
      'data-target-line': isTarget ? '' : undefined,
    },
    h('td', { className: 'dsb-pv-ln', 'aria-hidden': true }, lineNum),
    h('td', { className: 'dsb-pv-line' }, content)))
  }
  if (bottomPad > 0) {
    visibleRows.push(h('tr', { key: 'pad-bot', className: 'dsb-pv-spacer', 'aria-hidden': true },
      h('td', { colSpan: 2, style: { height: `${bottomPad}px`, padding: 0, border: 0 } })))
  }

  return h('div', {
    ref: wrapRef,
    className: 'dsb-pv-code-wrap',
    'data-wrap': wordWrap ? '' : undefined,
    'data-virtualized': isVirtualized ? '' : undefined,
    'data-total-lines': lines.length,
    onScroll,
  },
  h('table', { className: highlighted ? 'dsb-pv-code hljs' : 'dsb-pv-code' },
    h('tbody', null, visibleRows)))
}

function TablePreview({ text, delimiter }) {
  const { headers, rows, truncatedRows } = useMemo(
    () => parseDelimitedTable(text, delimiter),
    [text, delimiter],
  )
  if (headers.length === 0) return h('div', { className: 'dsb-rp-empty' }, t('Empty file'))
  return h('div', { className: 'dsb-pv-table-wrap' },
    h('table', { className: 'dsb-pv-table' },
      h('thead', null, h('tr', null,
        h('th', { className: 'dsb-pv-rn', 'aria-hidden': true }, '#'),
        headers.map((col, idx) => h('th', { key: idx }, col || t('Column {n}', { n: idx + 1 }))))),
      h('tbody', null, rows.map((cells, rIdx) => h('tr', { key: rIdx },
        h('td', { className: 'dsb-pv-rn' }, rIdx + 1),
        headers.map((_, cIdx) => h('td', { key: cIdx }, cells[cIdx] ?? '')))))),
    truncatedRows ? h('p', { className: 'dsb-pv-note' }, t('Showing first {count} rows', { count: MAX_TABLE_ROWS })) : null)
}

export function colIndexToLetters(index) {
  let n = index + 1
  let out = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

function SpreadsheetPreview({ file }) {
  const sheets = useMemo(() => (Array.isArray(file.sheets) ? file.sheets : []), [file.sheets])
  const initialIndex = useMemo(() => {
    const visible = sheets.findIndex(sheet => sheet.state !== 'hidden' && sheet.state !== 'veryHidden')
    return visible >= 0 ? visible : 0
  }, [file.path, sheets])
  const [sheetIdx, setSheetIdx] = useState(initialIndex)
  const [selected, setSelected] = useState(null)
  const [copiedCell, setCopiedCell] = useState(false)
  const tabRefs = useRef([])
  const copyTimer = useRef(0)

  useEffect(() => {
    setSheetIdx(initialIndex)
    setSelected(null)
    setCopiedCell(false)
  }, [file.path, initialIndex])
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current) }, [])

  const safeIdx = sheetIdx >= 0 && sheetIdx < sheets.length ? sheetIdx : 0
  const sheet = sheets[safeIdx] ?? null
  const rows = Array.isArray(sheet?.rows) ? sheet.rows : []
  const colCount = Math.max(0, sheet?.colCount ?? (rows[0]?.length ?? 0))
  const colHeaders = useMemo(() => Array.from({ length: colCount }, (_, idx) => colIndexToLetters(idx)), [colCount])

  const mergeLayout = useMemo(() => {
    const spans = new Map()
    const covered = new Set()
    for (const m of sheet?.merges ?? []) {
      const rowSpan = Math.max(1, (m.r2 - m.r1) + 1)
      const colSpan = Math.max(1, (m.c2 - m.c1) + 1)
      if (rowSpan === 1 && colSpan === 1) continue
      spans.set(`${m.r1}:${m.c1}`, { rowSpan, colSpan })
      for (let r = m.r1; r <= m.r2; r += 1) {
        for (let c = m.c1; c <= m.c2; c += 1) {
          if (r !== m.r1 || c !== m.c1) covered.add(`${r}:${c}`)
        }
      }
    }
    return { spans, covered }
  }, [sheet])

  if (!sheet) return h('div', { className: 'dsb-rp-empty' }, t('Empty file'))

  const rowCount = sheet.rowCount ?? rows.length
  const totalRowsLabel = Number.isFinite(sheet.totalRows) ? sheet.totalRows : `${rowCount}+`
  const truncationParts = [
    sheet.truncatedRows
      ? (Number.isFinite(sheet.totalRows)
        ? t('Showing first {shown} of {total} rows', { shown: rowCount, total: sheet.totalRows })
        : t('Showing first {count} rows', { count: rowCount }))
      : null,
    sheet.truncatedCols ? t('Showing first {shown} of {total} columns', { shown: colCount, total: sheet.totalCols }) : null,
    file.truncatedSheets ? t('Showing first {shown} of {total} sheets', { shown: sheets.length, total: file.totalSheets }) : null,
    (sheet.truncatedText || sheet.truncatedBySize || file.truncatedText) ? t('Preview truncated for size') : null,
  ].filter(Boolean)

  const activeCell = selected && rows[selected.r] ? rows[selected.r][selected.c] ?? null : null
  const activeRef = selected ? `${colIndexToLetters(selected.c)}${selected.r + 1}` : ''
  const activeText = activeCell ? (activeCell.f ? `${activeCell.f}  →  ${activeCell.v}` : activeCell.v) : ''

  const copySelected = () => {
    if (!activeCell) return
    const text = activeCell.v ?? ''
    void writeClipboard(text).then((ok) => {
      if (!ok) return
      setCopiedCell(true)
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => { copyTimer.current = 0; setCopiedCell(false) }, 1200)
    })
  }

  const onTabKeyDown = (event) => {
    if (sheets.length <= 1) return
    let next = -1
    if (event.key === 'ArrowRight') next = (safeIdx + 1) % sheets.length
    else if (event.key === 'ArrowLeft') next = (safeIdx - 1 + sheets.length) % sheets.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = sheets.length - 1
    if (next < 0) return
    event.preventDefault()
    setSheetIdx(next)
    setSelected(null)
    tabRefs.current[next]?.focus?.()
  }

  return h('div', { className: 'dsb-pv-xlsx' },
    h('div', { className: 'dsb-pv-formula-bar' },
      h('span', { className: 'dsb-pv-cell-ref' }, activeRef || `${totalRowsLabel} × ${sheet.totalCols ?? colCount}`),
      h('span', { className: 'dsb-pv-cell-val', title: activeText },
        selected
          ? (activeCell?.f
            ? h('span', null, h('code', { className: 'dsb-pv-formula-expr' }, activeCell.f), activeCell.v !== activeCell.f ? ` = ${activeCell.v}` : '')
            : (activeCell?.v ?? ''))
          : t('Click a cell to inspect')),
      activeCell ? h('button', {
        type: 'button',
        className: 'bt-icon-btn dsb-pv-copy',
        'aria-label': copiedCell ? t('Copied') : t('Copy'),
        title: copiedCell ? t('Copied') : t('Copy'),
        onClick: copySelected,
      }, copiedCell ? h(CheckIcon) : h(CopyIcon)) : null),
    truncationParts.length > 0
      ? h('div', { className: 'dsb-pv-banner' }, truncationParts.join(' · '))
      : null,
    rows.length === 0 || colCount === 0
      ? h('div', { className: 'dsb-rp-empty' }, t('Empty sheet'))
      : h('div', { className: 'dsb-pv-table-wrap dsb-pv-sheet-wrap' },
        h('table', { className: 'dsb-pv-table dsb-pv-sheet' },
          h('thead', null, h('tr', null,
            h('th', { className: 'dsb-pv-rn dsb-pv-sheet-corner', 'aria-hidden': true }, ''),
            colHeaders.map((letter, cIdx) => h('th', {
              key: letter,
              scope: 'col',
              'data-active': selected?.c === cIdx ? '' : undefined,
            }, letter)))),
          h('tbody', null, rows.map((row, rIdx) => h('tr', { key: rIdx },
            h('td', {
              className: 'dsb-pv-rn',
              'data-active': selected?.r === rIdx ? '' : undefined,
            }, rIdx + 1),
            colHeaders.map((_, cIdx) => {
              const key = `${rIdx}:${cIdx}`
              if (mergeLayout.covered.has(key)) return null
              const span = mergeLayout.spans.get(key)
              const cell = row?.[cIdx] ?? null
              const isSelected = selected?.r === rIdx && selected?.c === cIdx
              const cls = [
                'dsb-pv-sheet-cell',
                cell?.num ? 'is-num' : '',
                cell?.err ? 'is-err' : '',
                cell?.f ? 'has-formula' : '',
              ].filter(Boolean).join(' ')
              return h('td', {
                key: cIdx,
                className: cls,
                rowSpan: span?.rowSpan,
                colSpan: span?.colSpan,
                'data-selected': isSelected ? '' : undefined,
                title: cell?.f ? `${cell.f}\n${cell.v}` : (cell?.v || undefined),
                onClick: () => setSelected({ r: rIdx, c: cIdx }),
              }, cell?.v ?? '')
            })))))),
    h('div', {
      className: 'dsb-pv-sheet-tabs',
      role: 'tablist',
      'aria-label': t('Sheets'),
      onKeyDown: onTabKeyDown,
    },
    sheets.map((entry, idx) => h('button', {
      key: `${entry.name}:${idx}`,
      ref: (el) => { tabRefs.current[idx] = el },
      type: 'button',
      role: 'tab',
      className: 'dsb-pv-sheet-tab',
      'aria-selected': idx === safeIdx,
      tabIndex: idx === safeIdx ? 0 : -1,
      'data-hidden-sheet': entry.state && entry.state !== 'visible' ? '' : undefined,
      onClick: () => { setSheetIdx(idx); setSelected(null) },
    }, entry.name))))
}

function stepZoom(steps, current, delta) {
  const base = current ?? 100
  if (delta > 0) {
    const next = steps.find(step => step > base)
    return next ?? steps[steps.length - 1]
  }
  const prev = [...steps].reverse().find(step => step < base)
  return prev ?? steps[0]
}

function ZoomControls({ zoom, steps, onChange, allowFit = false }) {
  const minStep = steps[0]
  const maxStep = steps[steps.length - 1]
  const effective = zoom ?? 100
  const label = zoom === null ? t('Fit to view') : `${zoom}%`
  return h('div', { className: 'dsb-pv-zoom', role: 'group', 'aria-label': t('Zoom') },
    h('button', {
      type: 'button',
      className: 'bt-icon-btn dsb-pv-zoom-btn',
      'aria-label': t('Zoom out'),
      title: t('Zoom out'),
      disabled: zoom !== null && effective <= minStep,
      onClick: () => onChange(stepZoom(steps, zoom, -1)),
    }, h(MinusIcon)),
    h('button', {
      type: 'button',
      className: 'dsb-pv-zoom-readout',
      'aria-label': t('Reset zoom'),
      title: t('Reset zoom'),
      onClick: () => onChange(allowFit ? (zoom === null ? 100 : null) : 100),
    }, label),
    h('button', {
      type: 'button',
      className: 'bt-icon-btn dsb-pv-zoom-btn',
      'aria-label': t('Zoom in'),
      title: t('Zoom in'),
      disabled: zoom !== null && effective >= maxStep,
      onClick: () => onChange(stepZoom(steps, zoom, 1)),
    }, h(PlusSmallIcon)))
}

function PdfPreview({ file }) {
  const blobUrl = useBlobUrl(file.base64, file.mime || 'application/pdf')
  const [zoom, setZoom] = useState(100)
  useEffect(() => { setZoom(100) }, [file?.path, file?.base64])
  const downloadName = file.convertedFrom
    ? `${file.name.replace(/\.[^.]+$/, '')}.pdf`
    : file.name
  const frameSrc = blobUrl ? (zoom === 100 ? blobUrl : `${blobUrl}#zoom=${zoom}`) : null
  return h('div', { className: 'dsb-pv-pdf-wrap' },
    h('div', { className: 'dsb-pv-banner dsb-pv-pdf-bar' },
      h('div', { className: 'dsb-pv-pdf-left' },
        file.convertedFrom ? h('span', null, t('Converted from {ext}', { ext: file.convertedFrom.toUpperCase() })) : null,
        file.convertedFrom && blobUrl
          ? h('a', { className: 'bt-soft bt-soft-sm', href: blobUrl, download: downloadName }, h(DownloadIcon), t('Save'))
          : null),
      blobUrl ? h(ZoomControls, { zoom, steps: PDF_ZOOM_STEPS, onChange: setZoom, allowFit: false }) : null),
    frameSrc
      ? h('iframe', { key: `${blobUrl}:${zoom}`, className: 'dsb-pv-frame', src: frameSrc, title: file.name, 'data-zoom': zoom })
      : h('div', { className: 'dsb-rp-empty' }, t('Preview unavailable in this environment')))
}

function ImagePreview({ file }) {
  const blobUrl = useBlobUrl(file.base64, file.mime)
  const [zoom, setZoom] = useState(null)
  const [natural, setNatural] = useState({ w: 0, h: 0 })

  useEffect(() => {
    setZoom(null)
    setNatural({ w: 0, h: 0 })
  }, [file?.path, file?.base64])

  const src = blobUrl ?? (file.base64 ? `data:${file.mime};base64,${file.base64}` : '')
  if (!src) return h('div', { className: 'dsb-rp-empty' }, t('Preview unavailable in this environment'))

  const imgStyle = zoom === null
    ? undefined
    : (natural.w > 0
      ? { width: `${Math.round((natural.w * zoom) / 100)}px`, height: 'auto', maxWidth: 'none', maxHeight: 'none' }
      : { width: `${zoom}%`, maxWidth: 'none', maxHeight: 'none' })

  const onWheel = (event) => {
    if (!event.ctrlKey && !event.metaKey) return
    event.preventDefault()
    const delta = event.deltaY < 0 ? 1 : -1
    setZoom(current => stepZoom(IMAGE_ZOOM_STEPS, current, delta))
  }

  return h('div', { className: 'dsb-pv-image-shell' },
    h('div', { className: 'dsb-pv-banner dsb-pv-image-bar' },
      natural.w > 0 ? h('span', { className: 'dsb-pv-image-dims' }, `${natural.w} × ${natural.h}`) : h('span', null),
      h(ZoomControls, { zoom, steps: IMAGE_ZOOM_STEPS, onChange: setZoom, allowFit: true })),
    h('div', {
      className: zoom === null ? 'dsb-pv-image-wrap' : 'dsb-pv-image-wrap is-zoomed',
      'data-zoom': zoom === null ? 'fit' : String(zoom),
      onWheel,
    },
    h('img', {
      className: zoom === null ? 'dsb-pv-image' : 'dsb-pv-image is-zoomed',
      src,
      alt: file.name,
      style: imgStyle,
      onLoad: (event) => {
        const w = event.currentTarget?.naturalWidth ?? 0
        const ht = event.currentTarget?.naturalHeight ?? 0
        if (w > 0 && ht > 0) setNatural({ w, h: ht })
      },
    })))
}

export function HtmlPreviewNotice() {
  return h('div', { className: 'dsb-pv-banner' }, t('Scripts and external or local resources are blocked in this preview'))
}

export function HtmlPreviewFrame({ html, title }) {
  return h('div', { className: 'dsb-pv-html-wrap' },
    h('iframe', { className: 'dsb-pv-frame dsb-pv-html', sandbox: '', referrerPolicy: 'no-referrer', srcDoc: html, title }))
}

/**
 * Multi-format workspace file preview component.
 */
export function FilePreview({
  file,
  line = null,
  loading,
  error,
  onRetry,
  updated = false,
  onReload = null,
  autoRefresh = false,
  onToggleAutoRefresh = null,
}) {
  const [mode, setMode] = useState('preview')
  const [wordWrap, setWordWrap] = useState(readSavedWrap)
  const [copied, setCopied] = useState(false)
  const copyTimerRef = useRef(0)
  const htmlPreview = useMemo(() => (file?.kind === 'html' ? prepareHtmlPreview(file.text) : null), [file?.kind, file?.text])

  useEffect(() => {
    setMode(Number.isInteger(line) && line > 0 && (file?.kind === 'markdown' || file?.kind === 'html' || file?.kind === 'table' || file?.kind === 'svg') ? 'source' : 'preview')
    setCopied(false)
  }, [file?.path, file?.kind, line])
  useEffect(() => () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current) }, [])

  if (loading && !file) {
    return h('div', { className: 'dsb-rp-empty' }, t('Loading…'))
  }
  if (error) {
    return h('div', { className: 'dsb-rp-error', role: 'alert' },
      h('p', null, error),
      onRetry ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onRetry }, t('Retry')) : null)
  }
  if (!file) {
    return h('div', { className: 'dsb-rp-empty' }, t('Select a file to preview'))
  }

  const canToggleSource = file.kind === 'markdown' || file.kind === 'html' || file.kind === 'table' || (file.kind === 'svg' && Boolean(file.base64))
  const isCodeView = file.kind === 'code'
    || file.kind === 'text'
    || (canToggleSource && mode === 'source')
    || (file.kind === 'svg' && !file.base64)
  const canCopyText = typeof file.text === 'string'
  const copy = () => {
    if (!canCopyText) return
    void writeClipboard(file.text).then((ok) => {
      if (!ok) return
      setCopied(true)
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => { copyTimerRef.current = 0; setCopied(false) }, 1200)
    })
  }
  const toggleWrap = () => {
    setWordWrap((cur) => {
      const next = !cur
      writeSavedWrap(next)
      return next
    })
  }

  const badge = file.convertedFrom ? file.convertedFrom.slice(1).toUpperCase()
    : file.kind === 'spreadsheet' ? (file.ext ? file.ext.slice(1).toUpperCase() : 'XLSX')
      : file.language && file.language !== 'text' ? file.language.toUpperCase()
        : file.kind === 'table' ? (file.delimiter === '\t' ? 'TSV' : 'CSV')
          : file.kind.toUpperCase()

  return h('div', { className: 'dsb-pv' },
    h('div', { className: 'dsb-pv-bar' },
      h('span', { className: 'dsb-pv-path', title: file.path }, file.path || file.name),
      h('span', { className: 'dsb-pv-meta' },
        badge ? h('span', { className: 'dsb-pv-badge' }, badge) : null,
        Number.isFinite(file.size) ? h('span', null, fileSizeText(file.size)) : null),
      canToggleSource ? h('div', { className: 'dsb-pv-seg', role: 'group' },
        h('button', {
          type: 'button',
          className: 'dsb-pv-seg-btn',
          'aria-pressed': mode === 'preview',
          onClick: () => setMode('preview'),
        }, t('Preview')),
        h('button', {
          type: 'button',
          className: 'dsb-pv-seg-btn',
          'aria-pressed': mode === 'source',
          onClick: () => setMode('source'),
        }, t('Source'))) : null,
      isCodeView ? h('button', {
        type: 'button',
        className: 'bt-icon-btn dsb-pv-wrap-btn',
        'aria-pressed': wordWrap,
        'aria-label': t('Wrap lines'),
        title: t('Wrap lines'),
        onClick: toggleWrap,
      }, h(WrapIcon)) : null,
      onToggleAutoRefresh ? h('label', { className: 'dsb-pv-auto' },
        h('span', { className: 'dsb-pv-auto-label' }, t('Auto-refresh')),
        h('button', {
          type: 'button',
          role: 'switch',
          className: 'bt-switch',
          'aria-checked': autoRefresh,
          'aria-label': t('Auto-refresh'),
          onClick: onToggleAutoRefresh,
        }, h('span', { className: 'bt-switch-knob', 'aria-hidden': true }))) : null,
      canCopyText ? h('button', {
        type: 'button',
        className: 'bt-icon-btn dsb-pv-copy',
        'aria-label': copied ? t('Copied') : t('Copy'),
        title: copied ? t('Copied') : t('Copy'),
        onClick: copy,
      }, copied ? h(CheckIcon) : h(CopyIcon)) : null),
    updated && onReload ? h('div', { className: 'dsb-pv-banner dsb-pv-updated', role: 'status' },
      h('button', {
        type: 'button',
        className: 'dsb-pv-reload-btn',
        onClick: onReload,
      }, h(RefreshSmallIcon), h('span', null, t('Updated · Reload')))) : null,
    file.truncated ? h('div', { className: 'dsb-pv-banner' }, t('File truncated for preview')) : null,
    file.kind === 'html' && mode === 'preview' && htmlPreview?.blocked === true ? h(HtmlPreviewNotice) : null,
    h('div', { className: 'dsb-pv-body' },
      file.kind === 'markdown'
        ? (mode === 'source' ? h(CodeLines, { text: file.text, language: 'markdown', targetLine: line, wordWrap, fileKey: file.path || file.name }) : h('div', { className: 'dsb-pv-md' }, h(MarkdownText, {
          text: file.text,
          labels: { code: { copyLabel: t('Copy'), copiedLabel: t('Copied') } },
        })))
        : file.kind === 'table'
          ? (mode === 'source' ? h(CodeLines, { text: file.text, targetLine: line, wordWrap, fileKey: file.path || file.name }) : h(TablePreview, { text: file.text, delimiter: file.delimiter }))
          : file.kind === 'spreadsheet'
            ? h(SpreadsheetPreview, { file })
            : file.kind === 'html'
            ? (mode === 'source'
                ? h(CodeLines, { text: file.text, language: 'xml', targetLine: line, wordWrap, fileKey: file.path || file.name })
                : htmlPreview === null
                  ? h('div', { className: 'dsb-pv-html-wrap' }, h('div', { className: 'dsb-rp-empty' }, t('Preview unavailable in this environment')))
                  : h(HtmlPreviewFrame, { html: htmlPreview.html, title: file.name }))
            : file.kind === 'svg'
              ? (mode === 'source' || !file.base64 ? h(CodeLines, { text: file.text, language: 'xml', targetLine: line, wordWrap, fileKey: file.path || file.name }) : h(ImagePreview, { file }))
              : file.kind === 'image'
                ? h(ImagePreview, { file })
                : file.kind === 'pdf'
                  ? h(PdfPreview, { file })
                  : file.kind === 'code' || file.kind === 'text'
                    ? h(CodeLines, { text: file.text, language: file.language || '', targetLine: line, wordWrap, fileKey: file.path || file.name })
                    : h('div', { className: 'dsb-pv-fallback' },
                      h('span', { className: 'dsb-pv-fallback-ico', 'aria-hidden': true }, h(FileIcon)),
                      h('strong', null, file.name),
                      h('span', { className: 'dsb-pv-note' },
                        file.kind === 'too-large'
                          ? t('File too large (max {size})', { size: fileSizeText(file.maxBytes) })
                          : file.kind === 'office-unavailable'
                            ? t('Office preview is unavailable on this host')
                            : t('Binary file cannot be previewed as text')))))
}
