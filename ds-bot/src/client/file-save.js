// Save for the cards DSH delivers in a Bot chat (the files a turn presented). The
// card's action slot hands over the present route it would open; the host reads that
// exact file back as bytes, and the browser hands them to the device through a
// download — the same path a phone browser uses for any download.
import { createElement as h, useState } from 'react'
import { fileChunks } from '../shared/file-chunks.js'
import { call } from './api.js'
import { t } from './i18n.js'
import { presentedFileTarget } from './file-target.js'

// The slot's action area on one delivered-file card. `available` is DSH's answer to
// whether the Host can read the file; `pending` is its own action running.
export function SaveFileAction({ actionUrl, available = true, pending = false }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const target = presentedFileTarget(actionUrl)
  if (target === null) return null
  const save = () => {
    setBusy(true)
    setError(null)
    void (async () => {
      const parts = []
      let saved
      for await (const part of fileChunks(call, target)) { parts.push(part.data); saved = part }
      const url = URL.createObjectURL(new Blob(parts, { type: saved.mime }))
      const link = Object.assign(document.createElement('a'), { href: url, download: saved.name })
      document.body.append(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    })().catch(failure => setError(failure?.message ?? t('Could not save this file'))).finally(() => setBusy(false))
  }
  return h('span', { className: 'bt-file-save' },
    h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy || pending || available !== true, onClick: save },
      busy ? t('Saving…') : t('Save')),
    error === null ? null : h('span', { className: 'bt-set-hint', role: 'alert' }, error))
}
