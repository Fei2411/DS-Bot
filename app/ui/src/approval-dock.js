import { createElement as h, useEffect, useRef, useState } from 'react'
import { hostText, t } from '../../../ds-bot/src/client/i18n.js'

const EMPTY_APPROVALS = []

/**
 * Selects pending foreground DM or Classic Agent tool approvals (excludes group &
 * background-task approvals, which `HeaderPill` already owns via `ApprovalIslandPod` / `TaskIslandPod`).
 */
export function foregroundApprovalsOf(approvals, botId, sessionId = null) {
  if (!Array.isArray(approvals) || approvals.length === 0) return EMPTY_APPROVALS
  if (botId) {
    return approvals.filter(entry => entry
      && entry.botId === botId
      && !entry.taskId
      && !entry.roomId
      && entry.answerable !== false)
  }
  if (sessionId) {
    return approvals.filter(entry => entry
      && entry.sessionId === sessionId
      && !entry.botId
      && !entry.taskId
      && !entry.roomId
      && entry.answerable !== false)
  }
  return EMPTY_APPROVALS
}

function ApprovalCard({ entry, actions, readOnly }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const busyRef = useRef(false)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  const decide = async (choice) => {
    if (busyRef.current || busy || readOnly || typeof actions?.answerApproval !== 'function') return
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      await actions.answerApproval(entry.id, choice)
    } catch (failure) {
      busyRef.current = false
      if (mountedRef.current) {
        setError(hostText(failure?.message ?? String(failure)))
        setBusy(false)
      }
    }
  }
  const code = typeof entry.detail?.code === 'string' && entry.detail.code.trim() !== '' ? entry.detail.code : ''
  const detailText = typeof entry.detail?.text === 'string' && entry.detail.text.trim() !== '' ? entry.detail.text : ''
  const reason = typeof entry.reason === 'string' && entry.reason.trim() !== '' ? entry.reason : ''
  return h('div', { className: 'dsb-approval', role: 'region', 'aria-label': t('Waiting for approval') },
    h('div', { className: 'dsb-approval-head' },
      h('span', { className: 'dsb-approval-dot', 'aria-hidden': true }),
      h('span', { className: 'dsb-approval-title' }, t('Waiting for approval')),
      entry.tool ? h('span', { className: 'dsb-approval-tool', title: entry.tool }, entry.tool) : null),
    code ? h('pre', { className: 'dsb-approval-code' }, h('code', null, code)) : null,
    detailText ? h('p', { className: 'dsb-approval-text' }, detailText) : null,
    reason ? h('p', { className: 'dsb-approval-reason' }, reason) : null,
    error ? h('p', { className: 'dsb-approval-error', role: 'alert' }, error) : null,
    h('div', { className: 'dsb-approval-foot' },
      h('button', {
        type: 'button',
        className: 'bt-q-btn',
        disabled: busy || readOnly,
        onClick: () => { void decide('reject') },
      }, t('Reject')),
      h('button', {
        type: 'button',
        className: 'bt-q-submit',
        disabled: busy || readOnly,
        onClick: () => { void decide('allow') },
      }, t('Allow once'))))
}

/**
 * Foreground DM tool approval dock rendered above the composer.
 */
export function ApprovalDock({ botId, sessionId, useWork, actions, readOnly = false }) {
  const approvals = useWork?.(work => work?.approvals) ?? EMPTY_APPROVALS
  const pending = foregroundApprovalsOf(approvals, botId, sessionId)
  if (pending.length === 0) return null
  return h('div', { className: 'dsb-approval-dock', 'data-approval-dock': '' },
    pending.map(entry => h(ApprovalCard, { key: entry.id, entry, actions, readOnly })))
}
