import { createElement as h } from 'react'
import { MarkdownText } from './dsh-primitives.js'
import { mdLabels } from './btw.js'
import { dateLocale, t } from './i18n.js'

export function AutomationResults({ sessionId, turn, useRoster, actions, unanchored = false }) {
  const entries = useRoster(roster => (roster.monitorResults ?? []).filter(entry => entry.sessionId === sessionId && (unanchored ? entry.anchorTurn === null : entry.anchorTurn === turn?.turn)))
  if (entries.length === 0) return null
  return h('div', { className: 'bt-automation-results' }, entries.map(entry => h('article', { key: entry.id, className: 'bt-set-card bt-monitor-result' },
    h('div', { className: 'bt-set-row' }, h('strong', null, entry.title), h('time', { dateTime: new Date(entry.time).toISOString() }, new Date(entry.time).toLocaleString(dateLocale(), { dateStyle: 'medium', timeStyle: 'short' }))),
    h('div', { className: 'bt-set-row' }, h(MarkdownText, { text: entry.text, labels: mdLabels(), variant: 'compact' }), h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => actions.openSettings('schedules') }, t('View monitor runs'))))))
}

export const AUTOMATION_CSS = `
.bt-automation-results{display:flex;flex-direction:column;gap:12px}
.bt-monitor-result time{margin-left:auto;font-size:12px;color:var(--bt-ink-3);white-space:nowrap}
.bt-monitor-result .bt-soft{flex:none}
/* A narrow viewport turns .bt-set-row into a stretched column; keep the action compact. */
@media (max-width:640px){.bt-monitor-result .bt-soft{align-self:flex-start}}
`
