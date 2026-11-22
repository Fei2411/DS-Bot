import { createElement as h, useState } from 'react'
import { hostText, t } from '../../../ds-bot/src/client/i18n.js'

const EMPTY_APPROVALS = []

/**
 * Selects pending foreground DM tool approvals for `botId` (excludes group & background-task
 * approvals, which `HeaderPill` already owns via `ApprovalIslandPod` / `TaskIslandPod`).
 */
export function foregroundApprovalsOf(approvals, botId) {
  if (!botId || !Array.isArray(approvals) || approvals.length === 0) return EMPTY_APPROVALS
  return approvals.filter(entry => entry
    && entry.botId === botId
    && !entry.taskId
    && !entry.roomId
    && entry.answerable !== false)
}

function ApprovalCard({ entry, actions, readOnly }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const decide = async (choice) => {
    if (busy || readOnly || typeof actions?.answerApproval !== 'function') return
    setBusy(true)
    setError('')
    try {
      await actions.answerApproval(entry.id, choice)
    } catch (failure) {
      setError(hostText(failure?.message ?? String(failure)))
      setBusy(false)
    }
  }
  const code = typeof entry.detail?.code === 'string' && entry.detail.code.trim() !== '' ? entry.detail.code : ''
  const detailText = typeof entry.detail?.text === 'string' && entry.detail.text.trim() !== '' ? entry.detail.text : ''
  const reason = typeof entry.reason === 'string' && entry.reason.trim() !== '' ? entry.reason : ''
  return h('div', { className: 'dsb-approval', role: 'region', 'aria-label': t('Waiting for approval') },
    h('div', { className: 'dsb-approval-head' },
      h('span', { className: 'dsb-approval-dot', 'aria-hidden': true }),
      h('span', { className: 'dsb-approval-title' }, t('Waiting for approval')),
      entry.tool ? h('span', { className: 'dsb-approval-tool' }, entry.tool) : null),
    code ? h('pre', { className: 'dsb-approval-code' }, h('code', null, code)) : null,
    detailText ? h('p', { className: 'dsb-approval-text' }, detailText) : null,
    reason ? h('p', { className: 'dsb-approval-reason' }, reason) : null,
    error ? h('p', { className: 'dsb-approval-error', role: 'alert' }, error) : null,
    h('div', { className: 'dsb-approval-foot' },
      h('button', {
        type: 'button',
        className: 'bt-btask-btn',
        disabled: busy || readOnly,
        onClick: () => { void decide('reject') },
      }, t('Reject')),
      h('button', {
        type: 'button',
        className: 'bt-btask-btn is-primary',
        disabled: busy || readOnly,
        onClick: () => { void decide('allow') },
      }, t('Allow once'))))
}

/**
 * Foreground DM tool approval dock rendered above the composer.
 */
export function ApprovalDock({ botId, useWork, actions, readOnly = false }) {
  const approvals = useWork?.(work => work?.approvals) ?? EMPTY_APPROVALS
  const pending = foregroundApprovalsOf(approvals, botId)
  if (pending.length === 0) return null
  return h('div', { className: 'dsb-approval-dock', 'data-approval-dock': '' },
    pending.map(entry => h(ApprovalCard, { key: entry.id, entry, actions, readOnly })))
}
