import { createElement as h } from 'react'
import { MarkdownText } from './dsh-primitives.js'
import { mdLabels } from './btw.js'
import { t } from './i18n.js'

export function AutomationResults({ sessionId, turn, useRoster, actions, unanchored = false }) {
  const entries = useRoster(roster => (roster.monitorResults ?? []).filter(entry => entry.sessionId === sessionId && (unanchored ? entry.anchorTurn === null : entry.anchorTurn === turn?.turn)))
  if (entries.length === 0) return null
  return h('div', { className: 'bt-automation-results' }, entries.map(entry => h('article', { key: entry.id, className: 'bt-set-card bt-monitor-result' },
    h('div', { className: 'bt-set-row' }, h('strong', null, entry.title), h('time', { dateTime: new Date(entry.time).toISOString() }, new Date(entry.time).toLocaleString())),
    h('div', { className: 'bt-set-row' }, h(MarkdownText, { text: entry.text, labels: mdLabels(), variant: 'compact' })),
    h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => actions.openSettings('schedules') }, t('View monitor runs')))))
}
