// The delivered files a group row or an earlier chat row carries, as one card per ref
// on the pattern of the user's own attachment cards: the name, its type and size, and
// a save over the same bounded file-download route (#975, #1443). The live chat draws
// DSH's own delivered-file cards, so these mount only where DSH draws none.
import { createElement as h, useState } from 'react'
import * as ui from '@deepseek-ai/dsh-client-ui-primitives'
import { saveFileRef } from './file-save.js'
import { t } from './i18n.js'

const fileKey = file => `${file.sessionId}:${file.seq}:${file.index ?? 0}`

export function FileCards({ files }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [sizes, setSizes] = useState({})
  const save = (file) => {
    if (!Number.isInteger(file.seq)) return
    const key = fileKey(file)
    setBusy(true)
    setError(null)
    void saveFileRef({ sessionId: file.sessionId, seq: file.seq, index: file.index ?? 0 })
      // A row read back from history carries no size of its own; the first chunk has it.
      .then(saved => { if (Number.isFinite(saved?.size)) setSizes(all => ({ ...all, [key]: saved.size })) })
      .catch(failure => setError(failure?.message ?? t('Could not save this file')))
      .finally(() => setBusy(false))
  }
  return h('div', { className: 'bt-dfiles' },
    files.map(file => {
      const key = fileKey(file)
      const bytes = Number.isFinite(file.bytes) ? file.bytes : sizes[key]
      const meta = [ui.fileExtension?.(file.name)?.toUpperCase().slice(0, 8),
        Number.isFinite(bytes) ? ui.fileSizeText?.(bytes) : undefined].filter(Boolean).join(' · ')
      return h('span', { key, className: 'bt-dfile', title: file.name },
        ui.FileTypeIcon ? h(ui.FileTypeIcon, { path: file.name, className: 'bt-dfile-icon' }) : null,
        h('span', { className: 'bt-dfile-text' },
          h('span', { className: 'bt-dfile-name' }, file.name),
          meta === '' ? null : h('span', { className: 'bt-dfile-meta' }, meta)),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => save(file) }, busy ? t('Saving…') : t('Save')))
    }),
    error === null ? null : h('span', { className: 'bt-set-hint', role: 'alert' }, error))
}

export const FILE_CARD_CSS = `
.bt-dfiles{display:flex;flex-direction:column;gap:4px;align-items:flex-start}
.bt-dfile{display:inline-flex;align-items:center;gap:10px;box-sizing:border-box;width:240px;min-height:64px;padding:8px 12px;border-radius:18px;border:.5px solid var(--bt-line-2);background:var(--bt-card)}
.bt-dfile-icon{flex:none;width:28px;height:28px}
.bt-dfile-text{display:flex;flex-direction:column;min-width:0;flex:1}
.bt-dfile-name{font-size:14px;line-height:22px;font-weight:500;color:var(--bt-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-dfile-meta{font-size:12px;line-height:15px;color:var(--bt-ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
`
