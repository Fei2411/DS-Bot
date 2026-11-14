// A group opens the recorded turn in its own review sheet.
import { createElement as h } from 'react'
import { DiffIcon } from './icons.js'
import { t } from './i18n.js'

// The names a row shows before it counts the rest. Three fits one line at the width a
// group bubble has, even in the flat layout.
const NAMES = 3

export function ChangesCard({ changes, actions }) {
  if (changes === null || typeof changes !== 'object') return null
  const files = Array.isArray(changes.files) ? changes.files : []
  if (files.length === 0) return null
  const total = Number.isInteger(changes.total) ? changes.total : files.length
  const added = Number.isInteger(changes.added) ? changes.added : 0
  const deleted = Number.isInteger(changes.deleted) ? changes.deleted : 0
  const shown = files.slice(0, NAMES)
  const rest = total - shown.length
  return h('button', {
    type: 'button',
    className: 'bt-changes',
    'data-bt-changes': '',
    title: t('Review these changes'),
    onClick: () => actions.openChanges?.(changes),
  },
  h('span', { className: 'bt-changes-head' },
    h('span', { className: 'bt-changes-ico', 'aria-hidden': true }, h(DiffIcon)),
    h('span', { className: 'bt-changes-label' }, t(total === 1 ? '{count} file changed' : '{count} files changed', { count: total })),
    added > 0 ? h('span', { className: 'bt-changes-add' }, `+${added}`) : null,
    deleted > 0 ? h('span', { className: 'bt-changes-del' }, `−${deleted}`) : null),
  h('span', { className: 'bt-changes-files' },
    shown.map((file, index) => h('span', { key: index, className: 'bt-changes-file' }, file.path)),
    rest > 0 ? h('span', { className: 'bt-changes-file bt-changes-more' }, t('and {count} more', { count: rest })) : null))
}

export const CHANGES_CSS = `
.bt-changes{display:flex;flex-direction:column;gap:4px;max-width:min(560px,100%);margin:6px 0 0 46px;padding:7px 10px;border:1px solid var(--bt-line-2);border-radius:10px;background:var(--bt-card);color:var(--bt-ink);font-size:12px;line-height:17px;text-align:left;cursor:pointer;font-family:inherit}
.bt-changes:hover{border-color:var(--bt-accent);background:var(--bt-hover)}
.bt-changes:focus-visible{outline:2px solid var(--bt-accent);outline-offset:1px}
.bt-changes-head{display:flex;align-items:center;gap:6px;min-width:0}
.bt-changes-ico{display:inline-flex;color:var(--bt-ink-2)}
.bt-changes-label{font-weight:540;white-space:nowrap}
.bt-changes-add{color:var(--bt-green);font-variant-numeric:tabular-nums}
.bt-changes-del{color:var(--bt-danger);font-variant-numeric:tabular-nums}
.bt-changes-files{display:flex;flex-wrap:wrap;gap:0 10px;min-width:0;color:var(--bt-ink-2)}
.bt-changes-file{font-family:var(--bt-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px}
.bt-changes-more{font-family:inherit}
[data-bt-layout=flat] .bt-changes{margin-left:0}
@media (max-width:640px){.bt-changes{margin-left:0}}
`
