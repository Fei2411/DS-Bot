// The pieces the Canvas and Reader Apps share: the mode switch, the status line, the
// read-only source and the unified diff, and the empty and failure states. They only
// draw what a tab's file session holds.
import { createElement as h, useMemo, useState } from 'react'
import { Segmented } from './motion.js'
import { DIFF_LINES_MAX, changeRuns, diffLines, foldRows } from './line-diff.js'
import { SOURCE_SHOW_MAX } from './side-apps.js'
import { relativeShort } from './text.js'
import { t } from './i18n.js'

export const MODE_LABELS = {
  canvas: { preview: 'Render', source: 'Source', diff: 'Changes' },
  reader: { preview: 'Read', source: 'Source', diff: 'Changes' },
}

export function ModeSwitch({ app, mode, onMode, changes = 0 }) {
  return h(Segmented, { label: t('View'), value: mode, className: 'bt-sapp-seg' },
    ['preview', 'source', 'diff'].map(id => h('button', {
      key: id, type: 'button', 'aria-pressed': mode === id, onClick: () => onMode(id),
    }, t(MODE_LABELS[app][id]), id === 'diff' && changes > 0 ? h('span', { className: 'bt-sapp-count' }, changes) : null)))
}

// A file that cannot be shown, or has not shown yet.
export function FileEmpty({ status, path, message, onRetry }) {
  if (status === 'loading') return h('div', { className: 'bt-sapp-empty', role: 'status' }, h('span', { className: 'bt-shimmer' }, t('Loading…')))
  const missing = status === 'missing'
  return h('div', { className: 'bt-sapp-empty', role: 'status' },
    h('div', { className: 'bt-sapp-empty-title' }, missing ? t('File not found') : t("Couldn't read this file")),
    h('div', { className: 'bt-sapp-empty-path' }, path),
    message && !missing ? h('div', { className: 'bt-sapp-empty-note' }, message) : null,
    missing ? h('div', { className: 'bt-sapp-empty-note' }, t('It will show again if the file comes back.')) : null,
    onRetry ? h('button', { type: 'button', className: 'bt-soft', onClick: onRetry }, t('Try again')) : null)
}

// What the line under the toolbar says: when the file last changed, and what is pending.
export function StatusLine({ file, path, extra }) {
  const note = file.status === 'missing' ? t('File not found')
    : file.status === 'error' ? t("Couldn't read this file")
      : file.updatedAt ? (Date.now() - file.updatedAt < 4000 ? t('Updated just now') : t('Updated {time}', { time: relativeShort(file.updatedAt) })) : ''
  return h('div', { className: 'bt-sapp-status', 'data-status': file.status, title: path },
    h('span', { className: 'bt-sapp-status-path' }, path),
    note ? h('span', { className: 'bt-sapp-status-note' }, note) : null,
    extra)
}

// Plain monospace text with line numbers; no syntax colors. A very large file shows its start.
export function SourceView({ text, label }) {
  const shown = typeof text === 'string' && text.length > SOURCE_SHOW_MAX ? text.slice(0, SOURCE_SHOW_MAX) : text ?? ''
  const cut = shown.length < (text ?? '').length
  const lines = useMemo(() => shown.split('\n'), [shown])
  return h('div', { className: 'bt-sapp-source', role: 'region', 'aria-label': label ?? t('Source') },
    cut ? h('div', { className: 'bt-sapp-note' }, t('Showing the first 512 KiB')) : null,
    h('div', { className: 'bt-sapp-lines' },
      lines.map((line, index) => h('div', { key: index, className: 'bt-sapp-line' },
        h('span', { className: 'bt-sapp-no', 'aria-hidden': true }, index + 1),
        h('span', { className: 'bt-sapp-code' }, line === '' ? '\u200b' : line)))))
}

const MARK = { add: '+', del: '−', same: '' }

/** Which base a diff reads from, and what it says about it. */
export function chooseBase({ file, host }) {
  // The host's base is used only while it describes exactly the text on screen. After
  // the user marks a version reviewed, what was reviewed is not new again, so the host's
  // base is trusted only if it starts at that same version: a later Bot edit then reads
  // from the Bot's own before-text again, while an older base that reaches back past the
  // review is left out.
  const matches = host?.kind === 'host' && host.revision === file.revision && typeof host.before === 'string'
  if (matches && (file.reviewed !== true || host.baseRevision === file.baseRevision)) return { text: host.before, source: 'host' }
  return { text: file.base, source: 'snapshot' }
}

export function DiffView({ file, host, onReviewed }) {
  const [open, setOpen] = useState(() => new Set())
  const base = chooseBase({ file, host })
  const result = useMemo(() => (typeof file.text === 'string' && typeof base.text === 'string' ? diffLines(base.text, file.text) : null), [file.text, base.text])
  if (result === null) return h('div', { className: 'bt-sapp-empty' }, t('Nothing to compare yet'))
  if (result.tooLarge) return h('div', { className: 'bt-sapp-empty' }, h('div', { className: 'bt-sapp-empty-title' }, t('Diff too large')), h('div', { className: 'bt-sapp-empty-note' }, t('Both versions are longer than {count} lines. The source view still works.', { count: DIFF_LINES_MAX })))
  const folded = foldRows(result.rows, open)
  const same = result.added === 0 && result.removed === 0
  return h('div', { className: 'bt-sapp-diff', role: 'region', 'aria-label': t('Changes') },
    h('div', { className: 'bt-sapp-diffbar' },
      h('span', { className: 'bt-sapp-diffnote' }, base.source === 'host' ? t("Changes from the Bot's last edit") : t('Changes since this tab opened or was reviewed')),
      same ? null : h('span', { className: 'bt-sapp-diffnum' },
        h('span', { className: 'bt-sapp-add' }, `+${result.added}`),
        h('span', { className: 'bt-sapp-del' }, `−${result.removed}`)),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: same && base.source === 'snapshot', onClick: onReviewed }, t('Mark reviewed'))),
    same ? h('div', { className: 'bt-sapp-empty' }, t('No changes to review')) : h('div', { className: 'bt-sapp-lines' },
      folded.map((row, index) => (row.kind === 'fold'
        ? h('button', {
          key: `fold-${row.id}`, type: 'button', className: 'bt-sapp-fold',
          onClick: () => setOpen(prev => new Set(prev).add(row.id)),
        }, t('{count} unchanged lines', { count: row.count }))
        : h('div', { key: index, className: 'bt-sapp-line', 'data-kind': row.kind },
          h('span', { className: 'bt-sapp-no', 'aria-hidden': true }, row.to ?? row.from),
          h('span', { className: 'bt-sapp-mark', 'aria-hidden': true }, MARK[row.kind]),
          h('span', { className: 'bt-sapp-code' }, row.text === '' ? '\u200b' : row.text),
          row.kind === 'add' ? h('span', { className: 'bt-sapp-sr' }, t('added')) : row.kind === 'del' ? h('span', { className: 'bt-sapp-sr' }, t('removed')) : null)))))
}

export const diffCount = (file, host) => {
  if (typeof file.text !== 'string') return 0
  const base = chooseBase({ file, host })
  if (typeof base.text !== 'string') return 0
  const result = diffLines(base.text, file.text)
  return result.tooLarge ? 0 : changeRuns(result.rows)
}
