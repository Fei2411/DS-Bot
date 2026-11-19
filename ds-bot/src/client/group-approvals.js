// A group member's hidden Session raises approvals under that group's roomId, and the
// approval card lives in the group's details drawer (ApprovalCard in member-status.js).
// Showing an inline notice inside the active group round makes the pending approval
// obvious in the transcript and opens the group's details directly to answer it.
import { createElement as h } from 'react'
import { t } from './i18n.js'

/**
 * The approvals waiting on this group's own members, matching only entries that belong
 * to this group (`entry.roomId === room.id`). Own-chat approvals (`roomId === undefined`)
 * and approvals from other groups are never mixed in.
 * @param {{ sessionId?: string, roster: object, approvals: object[] }} state
 * @returns {Array<{ id: string, botId: string, roomId: string, name: string, tool: string, answerable: boolean }>}
 */
export function groupApprovals({ sessionId, roster, approvals }) {
  const room = sessionId === undefined ? undefined : roster?.roomsById?.[sessionId]
  if (room === undefined) return []
  const out = []
  for (const entry of approvals ?? []) {
    if (entry?.botId === undefined || entry.roomId !== room.id) continue
    out.push({
      id: String(entry.id ?? ''),
      botId: entry.botId,
      roomId: room.id,
      name: roster?.byId?.[entry.botId]?.name ?? t('A Bot'),
      tool: String(entry.tool ?? '').trim(),
      answerable: entry.answerable !== false,
    })
  }
  return out
}

/**
 * Inline notice shown in an open group round while a member waits for an approval.
 * @param {{ sessionId?: string, roster: object, actions: object, useWork: Function }} props
 */
export function GroupApprovalHints({ sessionId, roster, actions, useWork }) {
  const approvals = useWork?.(work => work?.approvals ?? []) ?? []
  const waiting = groupApprovals({ sessionId, roster, approvals })
  if (waiting.length === 0) return null
  return h('div', { className: 'bt-group-approvals' }, waiting.map(entry => h('div', { key: entry.id, className: 'bt-group-approval', role: 'note' },
    h('span', { className: 'bt-group-approval-text' }, entry.tool === ''
      ? t('{name} needs your approval to continue', { name: entry.name })
      : t('{name} needs your approval to run {tool}', { name: entry.name, tool: entry.tool })),
    entry.answerable && actions.showDetails
      ? h('button', {
          type: 'button', className: 'bt-group-approval-open',
          onClick: () => actions.showDetails(entry.roomId),
        }, t('Review approval'))
      : h('button', {
          type: 'button', className: 'bt-group-approval-open',
          onClick: () => actions.openSession(entry.botId),
        }, t("Open {name}'s chat", { name: entry.name })))))
}
