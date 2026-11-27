// Turn workspace change review tab for the right panel.
// Loads summaries and line-by-line hunks via `workspace-changes` (ctx.workspaceChanges).
import { createElement as h, useEffect, useState } from 'react'
import { call } from '../../../ds-bot/src/client/api.js'
import { hostText, t } from '../../../ds-bot/src/client/i18n.js'
import { DiffIcon, FileIcon } from '../../../ds-bot/src/client/icons.js'

function HunkTable({ hunks }) {
  if (!Array.isArray(hunks) || hunks.length === 0) {
    return h('div', { className: 'dsb-rp-empty' }, t('No line differences'))
  }
  return h('div', { className: 'dsb-chg-diff' }, hunks.map((hunk, hIdx) => {
    let oldLine = hunk.oldStart ?? 1
    let newLine = hunk.newStart ?? 1
    return h('div', { key: hIdx, className: 'dsb-chg-hunk' },
      h('div', { className: 'dsb-chg-hunk-hdr' }, `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`),
      h('table', { className: 'dsb-pv-code dsb-chg-table' },
        h('tbody', null, (hunk.lines ?? []).map((raw, lIdx) => {
          const text = String(raw ?? '')
          const prefix = text[0]
          const kind = prefix === '+' ? 'add' : prefix === '-' ? 'del' : 'ctx'
          const body = prefix === '+' || prefix === '-' || prefix === ' ' ? text.slice(1) : text
          const oNum = kind === 'add' ? '' : oldLine++
          const nNum = kind === 'del' ? '' : newLine++
          return h('tr', { key: lIdx, className: `dsb-chg-row is-${kind}` },
            h('td', { className: 'dsb-pv-ln', 'aria-hidden': true }, oNum),
            h('td', { className: 'dsb-pv-ln', 'aria-hidden': true }, nNum),
            h('td', { className: 'dsb-chg-sign', 'aria-hidden': true }, kind === 'add' ? '+' : kind === 'del' ? '−' : ' '),
            h('td', { className: 'dsb-pv-line' }, body || '\u00a0'))
        }))))
  }))
}

/**
 * Displays a turn's changed files and per-file unified diff hunks in the right panel.
 */
export function ChangesReview({ changes, onOpenFile }) {
  const [summary, setSummary] = useState(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [diff, setDiff] = useState(null)
  const [loadingSummary, setLoadingSummary] = useState(false)
  const [loadingDiff, setLoadingDiff] = useState(false)
  const [error, setError] = useState('')

  const sessionId = changes?.sessionId
  const seq = changes?.seq
  const validTarget = typeof sessionId === 'string' && sessionId !== '' && Number.isInteger(seq)

  useEffect(() => {
    if (!validTarget) {
      setSummary(null)
      setDiff(null)
      setLoadingSummary(false)
      setLoadingDiff(false)
      setError('')
      return undefined
    }
    let alive = true
    setSummary(null)
    setDiff(null)
    setLoadingDiff(false)
    setLoadingSummary(true)
    setError('')
    setSelectedIndex(0)
    void call('workspace-changes', { sessionId, seq })
      .then((res) => {
        if (!alive) return
        setSummary(res)
        setLoadingSummary(false)
      })
      .catch((failure) => {
        if (!alive) return
        setError(hostText(failure?.message ?? String(failure)))
        setSummary(null)
        setLoadingSummary(false)
      })
    return () => { alive = false }
  }, [validTarget, sessionId, seq])

  useEffect(() => {
    if (!validTarget || !summary || summary.sessionId !== sessionId || summary.seq !== seq || !summary.files?.length) {
      setDiff(null)
      setLoadingDiff(false)
      return undefined
    }
    const target = summary.files[selectedIndex]
    if (!target) {
      setDiff(null)
      setLoadingDiff(false)
      return undefined
    }
    let alive = true
    setLoadingDiff(true)
    void call('workspace-changes', { sessionId, seq, index: target.index })
      .then((res) => {
        if (!alive) return
        setDiff(res)
        setLoadingDiff(false)
      })
      .catch((failure) => {
        if (!alive) return
        setDiff({ kind: 'error', message: hostText(failure?.message ?? String(failure)) })
        setLoadingDiff(false)
      })
    return () => { alive = false }
  }, [validTarget, summary, selectedIndex, sessionId, seq])

  if (!changes || !validTarget) return h('div', { className: 'dsb-rp-empty' }, t('No changes selected'))
  if (error) return h('div', { className: 'dsb-rp-error', role: 'alert' }, h('p', null, error))
  if (loadingSummary || !summary) return h('div', { className: 'dsb-rp-empty' }, t('Loading…'))

  const files = summary.files ?? []
  const total = summary.total ?? files.length
  const added = summary.added ?? 0
  const deleted = summary.deleted ?? 0
  const currentFile = files[selectedIndex]

  if (files.length === 0) return h('div', { className: 'dsb-rp-empty' }, t('No line differences'))

  return h('div', { className: 'dsb-chg' },
    h('div', { className: 'dsb-chg-summary' },
      h('span', { className: 'dsb-chg-ico', 'aria-hidden': true }, h(DiffIcon)),
      h('span', { className: 'dsb-chg-count' }, t(total === 1 ? '{count} file changed' : '{count} files changed', { count: total })),
      added > 0 ? h('span', { className: 'bt-changes-add' }, `+${added}`) : null,
      deleted > 0 ? h('span', { className: 'bt-changes-del' }, `−${deleted}`) : null),
    h('div', { className: 'dsb-chg-files', role: 'listbox', 'aria-label': t('Changed files') },
      files.map((file, idx) => h('button', {
        key: `${file.index}:${file.path}`,
        type: 'button',
        role: 'option',
        className: 'dsb-chg-file',
        'aria-selected': idx === selectedIndex,
        onClick: () => setSelectedIndex(idx),
      },
      h('span', { className: 'dsb-chg-file-name', title: file.display }, file.display),
      h('span', { className: 'dsb-chg-file-stats' },
        file.binary ? h('span', { className: 'dsb-pv-badge' }, t('Binary'))
          : file.oversized ? h('span', { className: 'dsb-pv-badge' }, t('Large'))
            : [
                file.added > 0 ? h('span', { key: 'a', className: 'bt-changes-add' }, `+${file.added}`) : null,
                file.deleted > 0 ? h('span', { key: 'd', className: 'bt-changes-del' }, `−${file.deleted}`) : null,
              ])))),
    currentFile ? h('div', { className: 'dsb-chg-detail-bar' },
      h('span', { className: 'dsb-pv-path', title: currentFile.display }, currentFile.display),
      onOpenFile ? h('button', {
        type: 'button',
        className: 'bt-soft bt-soft-sm',
        onClick: () => onOpenFile({ path: currentFile.path, sessionId }),
      }, h(FileIcon), t('Open file')) : null) : null,
    h('div', { className: 'dsb-chg-body' },
      loadingDiff ? h('div', { className: 'dsb-rp-empty' }, t('Loading…'))
        : diff?.kind === 'text' ? h(HunkTable, { hunks: diff.hunks })
          : diff?.kind === 'binary' ? h('div', { className: 'dsb-rp-empty' }, t('Binary file cannot be previewed as text'))
            : diff?.kind === 'oversized' ? h('div', { className: 'dsb-rp-empty' }, t('File is too large for diff preview'))
              : diff?.kind === 'error' ? h('div', { className: 'dsb-rp-error', role: 'alert' }, h('p', null, diff.message))
                : null))
}
