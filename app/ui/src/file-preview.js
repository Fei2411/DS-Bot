// Multi-format document previewer for the workspace right panel:
// Markdown, code/text with line numbers, CSV/TSV spreadsheet tables, images, SVG,
// PDF (and libreoffice-kit converted Office documents), and strictly sandboxed HTML.
import { createElement as h, useEffect, useMemo, useRef, useState } from 'react'
import { fileSizeText, MarkdownText, writeClipboard } from '../../../ds-bot/src/client/dsh-primitives.js'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { CheckIcon, CopyIcon, DownloadIcon, FileIcon } from '../../../ds-bot/src/client/icons.js'
import { renderTokenList, useHighlightedLines } from './code-highlight.js'
import { prepareHtmlPreview } from './html-preview.js'

const MAX_TABLE_ROWS = 500
const MAX_TABLE_COLS = 64

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

function CodeLines({ text, language = '', targetLine = null }) {
  const source = String(text ?? '')
  const lines = useMemo(() => source.split(/\r?\n/), [source])
  const highlighted = useHighlightedLines(source, language)
  const targetRef = useRef(null)

  useEffect(() => {
    if (Number.isInteger(targetLine) && targetLine > 0) {
      targetRef.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
    }
  }, [targetLine, source])

  return h('div', { className: 'dsb-pv-code-wrap' },
    h('table', { className: highlighted ? 'dsb-pv-code hljs' : 'dsb-pv-code' },
      h('tbody', null, lines.map((line, idx) => {
        const lineNum = idx + 1
        const isTarget = targetLine === lineNum
        const tokens = highlighted?.[idx]
        const content = tokens && tokens.length > 0 ? renderTokenList(tokens, `l${idx}`) : (line || '\u00a0')
        return h('tr', {
          key: idx,
          ref: isTarget ? targetRef : undefined,
          'data-target-line': isTarget ? '' : undefined,
        },
        h('td', { className: 'dsb-pv-ln', 'aria-hidden': true }, lineNum),
        h('td', { className: 'dsb-pv-line' }, content))
      }))))
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

function PdfPreview({ file }) {
  const blobUrl = useBlobUrl(file.base64, file.mime || 'application/pdf')
  const downloadName = file.convertedFrom
    ? `${file.name.replace(/\.[^.]+$/, '')}.pdf`
    : file.name
  return h('div', { className: 'dsb-pv-pdf-wrap' },
    file.convertedFrom ? h('div', { className: 'dsb-pv-banner' },
      h('span', null, t('Converted from {ext}', { ext: file.convertedFrom.toUpperCase() })),
      blobUrl ? h('a', { className: 'bt-soft bt-soft-sm', href: blobUrl, download: downloadName }, h(DownloadIcon), t('Save')) : null) : null,
    blobUrl
      ? h('iframe', { className: 'dsb-pv-frame', src: blobUrl, title: file.name })
      : h('div', { className: 'dsb-rp-empty' }, t('Preview unavailable in this environment')))
}

function ImagePreview({ file }) {
  const blobUrl = useBlobUrl(file.base64, file.mime)
  const src = blobUrl ?? (file.base64 ? `data:${file.mime};base64,${file.base64}` : '')
  if (!src) return h('div', { className: 'dsb-rp-empty' }, t('Preview unavailable in this environment'))
  return h('div', { className: 'dsb-pv-image-wrap' },
    h('img', { className: 'dsb-pv-image', src, alt: file.name }))
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
export function FilePreview({ file, line = null, loading, error, onRetry }) {
  const [mode, setMode] = useState('preview')
  const [copied, setCopied] = useState(false)
  const copyTimerRef = useRef(0)
  const htmlPreview = useMemo(() => (file?.kind === 'html' ? prepareHtmlPreview(file.text) : null), [file?.kind, file?.text])

  useEffect(() => {
    setMode(Number.isInteger(line) && line > 0 && (file?.kind === 'markdown' || file?.kind === 'html' || file?.kind === 'table' || file?.kind === 'svg') ? 'source' : 'preview')
    setCopied(false)
  }, [file?.path, file?.kind, line])
  useEffect(() => () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current) }, [])

  if (loading) {
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
      canCopyText ? h('button', {
        type: 'button',
        className: 'bt-icon-btn dsb-pv-copy',
        'aria-label': copied ? t('Copied') : t('Copy'),
        title: copied ? t('Copied') : t('Copy'),
        onClick: copy,
      }, copied ? h(CheckIcon) : h(CopyIcon)) : null),
    file.truncated ? h('div', { className: 'dsb-pv-banner' }, t('File truncated for preview')) : null,
    file.kind === 'html' && mode === 'preview' && htmlPreview?.blocked === true ? h(HtmlPreviewNotice) : null,
    h('div', { className: 'dsb-pv-body' },
      file.kind === 'markdown'
        ? (mode === 'source' ? h(CodeLines, { text: file.text, language: 'markdown', targetLine: line }) : h('div', { className: 'dsb-pv-md' }, h(MarkdownText, {
          text: file.text,
          labels: { code: { copyLabel: t('Copy'), copiedLabel: t('Copied') } },
        })))
        : file.kind === 'table'
          ? (mode === 'source' ? h(CodeLines, { text: file.text, targetLine: line }) : h(TablePreview, { text: file.text, delimiter: file.delimiter }))
          : file.kind === 'spreadsheet'
            ? h(SpreadsheetPreview, { file })
            : file.kind === 'html'
            ? (mode === 'source'
                ? h(CodeLines, { text: file.text, language: 'xml', targetLine: line })
                : htmlPreview === null
                  ? h('div', { className: 'dsb-pv-html-wrap' }, h('div', { className: 'dsb-rp-empty' }, t('Preview unavailable in this environment')))
                  : h(HtmlPreviewFrame, { html: htmlPreview.html, title: file.name }))
            : file.kind === 'svg'
              ? (mode === 'source' || !file.base64 ? h(CodeLines, { text: file.text, language: 'xml', targetLine: line }) : h(ImagePreview, { file }))
              : file.kind === 'image'
                ? h(ImagePreview, { file })
                : file.kind === 'pdf'
                  ? h(PdfPreview, { file })
                  : file.kind === 'code' || file.kind === 'text'
                    ? h(CodeLines, { text: file.text, language: file.language || '', targetLine: line })
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
