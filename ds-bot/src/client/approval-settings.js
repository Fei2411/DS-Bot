import { createElement as h } from 'react'
import { t } from './i18n.js'

const LABELS = { allow: 'Approved once', reject: 'Rejected', manual: 'Manual review', cancelled: 'Cancelled' }
export const reviewsFor = (entries, id, group) => (entries ?? []).filter(entry => group ? entry.roomId === id : entry.botId === id && !entry.roomId).slice(-20).reverse()

export function ApprovalSettings({ target, group = false, roster, update, Card, SwitchRow }) {
  const entries = reviewsFor(roster.approvalReviews, target.id, group)
  return h(Card, { title: t('Approvals') },
    h(SwitchRow, {
      label: t('Review for me'), on: target.autoApprove === true,
      hint: t('Reviews pending approval requests; uncertain decisions come back to you.'),
      onChange: autoApprove => update({ autoApprove }),
    }),
    entries.length ? h('details', { className: 'bt-set-row bt-bs-stack' },
      h('summary', null, t('Recent approval reviews')),
      entries.map(entry => h('div', { key: entry.id, className: 'bt-set-row bt-bs-stack' },
        h('span', { className: 'bt-bs-label' }, entry.tool, ' · ', t(LABELS[entry.outcome] ?? 'Manual review')),
        h('span', { className: 'bt-set-hint' }, entry.reason),
        h('span', { className: 'bt-set-hint' }, new Date(entry.at).toLocaleString(), entry.model ? ' · ' + entry.model : '')))) : null)
}
