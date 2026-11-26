// Multi-format document previewer for the workspace right panel:
// Markdown, code/text with line numbers, CSV/TSV spreadsheet tables, images, SVG,
// PDF (and libreoffice-kit converted Office documents), and strictly sandboxed HTML.
import { createElement as h, useEffect, useMemo, useRef, useState } from 'react'
import { fileSizeText, MarkdownText, writeClipboard } from '../../../ds-bot/src/client/dsh-primitives.js'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { CheckIcon, CopyIcon, DownloadIcon, FileIcon } from '../../../ds-bot/src/client/icons.js'
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

function CodeLines({ text }) {
  const lines = useMemo(() => String(text ?? '').split(/\r?\n/), [text])
  return h('div', { className: 'dsb-pv-code-wrap' },
    h('table', { className: 'dsb-pv-code' },
      h('tbody', null, lines.map((line, idx) => h('tr', { key: idx },
        h('td', { className: 'dsb-pv-ln', 'aria-hidden': true }, idx + 1),
        h('td', { className: 'dsb-pv-line' }, line || '\u00a0'))))))
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
        headers.map((col, idx) => h('th', { key: idx }, col || `Col ${idx + 1}`)))),
      h('tbody', null, rows.map((cells, rIdx) => h('tr', { key: rIdx },
        h('td', { className: 'dsb-pv-rn' }, rIdx + 1),
        headers.map((_, cIdx) => h('td', { key: cIdx }, cells[cIdx] ?? '')))))),
    truncatedRows ? h('p', { className: 'dsb-pv-note' }, t('Showing first {count} rows', { count: MAX_TABLE_ROWS })) : null)
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
export function FilePreview({ file, loading, error, onRetry }) {
  const [mode, setMode] = useState('preview')
  const [copied, setCopied] = useState(false)
  const copyTimerRef = useRef(0)
  const htmlPreview = useMemo(() => (file?.kind === 'html' ? prepareHtmlPreview(file.text) : null), [file?.kind, file?.text])

  useEffect(() => {
    setMode('preview')
    setCopied(false)
  }, [file?.path, file?.kind])
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
        ? (mode === 'source' ? h(CodeLines, { text: file.text }) : h('div', { className: 'dsb-pv-md' }, h(MarkdownText, {
          text: file.text,
          labels: { code: { copyLabel: t('Copy'), copiedLabel: t('Copied') } },
        })))
        : file.kind === 'table'
          ? (mode === 'source' ? h(CodeLines, { text: file.text }) : h(TablePreview, { text: file.text, delimiter: file.delimiter }))
          : file.kind === 'html'
            ? (mode === 'source'
                ? h(CodeLines, { text: file.text })
                : htmlPreview === null
                  ? h('div', { className: 'dsb-pv-html-wrap' }, h('div', { className: 'dsb-rp-empty' }, t('Preview unavailable in this environment')))
                  : h(HtmlPreviewFrame, { html: htmlPreview.html, title: file.name }))
            : file.kind === 'svg'
              ? (mode === 'source' || !file.base64 ? h(CodeLines, { text: file.text }) : h(ImagePreview, { file }))
              : file.kind === 'image'
                ? h(ImagePreview, { file })
                : file.kind === 'pdf'
                  ? h(PdfPreview, { file })
                  : file.kind === 'code' || file.kind === 'text'
                    ? h(CodeLines, { text: file.text })
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
