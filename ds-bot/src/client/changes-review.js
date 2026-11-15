import { createElement as h, useEffect, useState } from 'react'
import { MarkdownText } from './dsh-primitives.js'
import { changesPatch } from '../shared/changes-patch.js'
import { useEscape } from './overlay-hooks.js'
import { mdLabels, t } from './i18n.js'

export function ChangesReview({ changes, paneLeft, actions }) {
  const [summary, setSummary] = useState(null)
  const [index, setIndex] = useState(0)
  const [diff, setDiff] = useState(null)
  const [error, setError] = useState(null)
  const [retry, setRetry] = useState(0)
  useEscape(actions.closeChanges)
  useEffect(() => {
    let stopped = false
    setError(null)
    actions.changesSummary(changes).then(value => { if (!stopped) setSummary(value) })
      .catch(error => { if (!stopped) setError(error.message) })
    return () => { stopped = true }
  }, [changes.sessionId, changes.seq, retry])
  useEffect(() => {
    if (summary === null) return undefined
    let stopped = false
    setDiff(null)
    setError(null)
    actions.changesDiff(changes, index).then(value => { if (!stopped) setDiff(value) })
      .catch(error => { if (!stopped) setError(error.message) })
    return () => { stopped = true }
  }, [summary, index, retry])
  return h('div', { className: 'bt-pane bt-exchange', style: { left: paneLeft } },
    h('div', { className: 'bt-dialog', role: 'dialog', 'aria-label': t('Review these changes') },
      h('div', { className: 'bt-head' }, h('span', { className: 'bt-pill' }, t('Review these changes'))),
      h('div', { className: 'bt-dialog-log' },
        summary ? h('select', { className: 'bt-select', value: index, 'aria-label': t('File'), onChange: event => setIndex(Number(event.target.value)) },
          summary.files.map((file, i) => h('option', { key: i, value: i }, `${file.display ?? file.path}  +${file.added} −${file.deleted}`))) : null,
        error ? h('div', { className: 'bt-hint', role: 'alert' }, t(error), ' ', h('button', { type: 'button', className: 'bt-soft', onClick: () => setRetry(value => value + 1) }, t('Retry')))
          : diff === null ? h('div', { className: 'bt-hint' }, t('Loading…'))
            : diff.kind === 'text' ? h(MarkdownText, { text: changesPatch(diff), labels: mdLabels(), variant: 'compact' })
              : h('div', { className: 'bt-hint' }, t(diff.kind === 'binary' ? 'Binary file' : 'This file is too large to preview'))),
      h('div', { className: 'bt-dialog-foot' }, h('button', { type: 'button', className: 'bt-soft', onClick: actions.closeChanges }, t('Close')))))
}
