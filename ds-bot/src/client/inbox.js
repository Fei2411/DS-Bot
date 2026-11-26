// Unified Agent Inbox: surfaces cross-Bot approvals, questions, requests, Watchdog
// stall/circuit-breaker alerts, and failed event deliveries in one calm dialog.
import { createElement as h, useState } from 'react'
import { CloseIcon } from './icons.js'
import { Segmented } from './motion.js'
import { useEscape } from './overlay-hooks.js'
import { dateLocale, t } from './i18n.js'

// Original stroke-only inbox tray icon on a 20x20 canvas (ui-standard.md §7).
export function InboxIcon() {
  return h('svg', { width: 16, height: 16, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    h('path', { d: 'M3.5 11.5L5.2 4.8A1.5 1.5 0 0 1 6.65 3.7h6.7a1.5 1.5 0 0 1 1.45 1.1l1.7 6.7' }),
    h('path', { d: 'M3.5 11.5h3.6l1.1 2h3.6l1.1-2h3.6v3.3a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5v-3.3z' }))
}

const fmtTime = (ms) => {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  return new Intl.DateTimeFormat(dateLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(ms)
}

export function InboxButton({ roster, actions }) {
  const count = roster.inbox?.count ?? 0
  const label = count > 0 ? t('Inbox ({count})', { count }) : t('Inbox')
  return h('button', {
    type: 'button',
    className: 'bt-round bt-inbox-btn',
    'data-has-items': count > 0 || undefined,
    'aria-label': label,
    title: label,
    onClick: () => actions.openInbox?.(),
  },
  h(InboxIcon),
  count > 0 ? h('span', { className: 'bt-inbox-badge', 'aria-hidden': true }, count > 99 ? '99+' : String(count)) : null)
}

const TABS = [['all', 'All'], ['review', 'Approvals'], ['question', 'Questions'], ['alert', 'Alerts']]

export function InboxDialog({ roster, actions, leaving }) {
  const [tab, setTab] = useState('all')
  const close = () => actions.closeInbox?.()
  useEscape(close)

  const readOnly = Boolean(roster.readOnly)
  const inbox = roster.inbox ?? { count: 0, counts: { review: 0, question: 0, alert: 0 }, items: [] }
  const items = tab === 'all' ? inbox.items : inbox.items.filter(item => item.category === tab)

  const canOpen = item => Boolean(
    item.roomId
    || item.botId
    || item.kind === 'watcher_paused'
    || item.kind === 'subscription_paused'
    || item.kind === 'dead_letter',
  )

  const openItem = (item) => {
    close()
    if (item.kind === 'watcher_paused' || item.kind === 'subscription_paused' || item.kind === 'dead_letter') {
      actions.openSettings?.('schedules', item.kind === 'watcher_paused' ? 'watchers' : 'subscriptions')
    } else if (item.roomId) {
      actions.openSession?.(item.roomId)
    } else if (item.botId) {
      actions.openSession?.(item.botId)
    }
  }

  const runAction = (promise) => {
    void Promise.resolve(promise).catch(err => actions.reportError?.(err, 'inbox'))
  }

  return h('div', { className: 'bt-settings-layer', 'data-leaving': leaving || undefined },
    h('div', { className: 'bt-scrim', onMouseDown: close }),
    h('div', { className: 'bt-inbox-dialog', role: 'dialog', 'aria-modal': true, 'aria-label': t('Inbox') },
      h('div', { className: 'bt-inbox-head' },
        h('h2', null, t('Inbox')),
        h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Close'), onClick: close }, h(CloseIcon))),
      h('div', { className: 'bt-inbox-bar' },
        h(Segmented, { label: t('Filter inbox'), value: tab }, TABS.map(([id, label]) => {
          const n = id === 'all' ? inbox.count : (inbox.counts?.[id] ?? 0)
          return h('button', { key: id, type: 'button', 'aria-pressed': tab === id, onClick: () => setTab(id) }, n > 0 ? `${t(label)} (${n})` : t(label))
        }))),
      h('div', { className: 'bt-inbox-list' },
        items.length === 0
          ? h('div', { className: 'bt-empty' }, t('Nothing needs your attention right now.'))
          : h('div', { className: 'bt-set-card' }, items.map(item => h('div', { key: item.id, className: 'bt-set-row bt-ev-row' },
              h('div', { className: 'bt-set-copy' },
                h('span', { className: 'bt-ev-title' },
                  item.title,
                  h('span', { className: 'bt-tag' }, t(item.category === 'review' ? 'Approval' : item.category === 'question' ? 'Question' : 'Alert'))),
                item.detail ? h('span', { className: 'bt-set-hint' }, item.detail) : null,
                item.time ? h('span', { className: 'bt-set-hint' }, fmtTime(item.time)) : null),
              h('div', { className: 'bt-ev-actions' },
                item.kind === 'watcher_paused' && item.watcherId
                  ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: readOnly, onClick: () => runAction(actions.watcherToggle?.(item.watcherId, true)) }, t('Resume')) : null,
                item.kind === 'subscription_paused' && item.subId
                  ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: readOnly, onClick: () => runAction(actions.subscriptionToggle?.(item.subId, true)) }, t('Resume')) : null,
                item.kind === 'dead_letter' && item.deadLetterId
                  ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: readOnly, onClick: () => runAction(actions.eventDeadLetterReplay?.(item.deadLetterId)) }, t('Replay')) : null,
                (item.kind === 'stalled_turn' || item.kind === 'rate_limit')
                  ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: readOnly, onClick: () => runAction(actions.eventAlertDismiss?.(item.id)) }, t('Dismiss')) : null,
                canOpen(item)
                  ? h('button', { type: 'button', className: 'bt-send bt-soft-sm', onClick: () => openItem(item) }, t('Open')) : null)))))))
}

export const INBOX_CSS = `
.bt-inbox-btn{position:relative}
.bt-inbox-btn[data-has-items]{color:var(--bt-accent)}
.bt-inbox-badge{position:absolute;top:-3px;right:-3px;min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:var(--bt-accent);color:var(--bt-accent-ink);font-size:10px;line-height:16px;font-weight:600;text-align:center;font-variant-numeric:tabular-nums;box-shadow:0 0 0 1.5px var(--bt-sidebar)}
.bt-inbox-dialog{position:relative;z-index:1;width:min(640px,100vw - 48px);max-height:min(700px,100vh - 64px);display:flex;flex-direction:column;border-radius:16px;background:var(--bt-main);border:.5px solid var(--bt-line-2);box-shadow:0 24px 80px rgba(0,0,0,.24);color:var(--bt-ink);font-family:var(--bt-font);overflow:hidden;animation:bt-dialog-rise .42s ease}
.bt-inbox-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px 10px;border-bottom:1px solid var(--bt-line)}
.bt-inbox-head h2{margin:0;font-size:15px;line-height:20px;font-weight:600}
.bt-inbox-bar{padding:12px 16px 0}
.bt-inbox-list{flex:1;min-height:0;overflow:auto;padding:12px 16px 16px}
`
