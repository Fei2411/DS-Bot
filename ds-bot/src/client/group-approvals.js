// An approval a group's member Bot is waiting on belongs to that Bot's own Session, so
// the shell draws its card there — and the group chat, where the user asked, said
// nothing and looked stuck (#1623). This is the line the group shows instead: who needs
// the approval, what for, and a way straight to that Bot's chat.
import { createElement as h } from 'react'
import { t } from './i18n.js'

/**
 * The approvals waiting on a group, one per member Bot that has one.
 * @param {{ sessionId?: string, roster: object, approvals: object[] }} state
 *   `sessionId` is the group Session the chat draws; `approvals` is `work.approvals`.
 * @returns {Array<{ id: string, botId: string, name: string, tool: string }>}
 */
export function groupApprovals({ sessionId, roster, approvals }) {
  const room = sessionId === undefined ? undefined : roster?.roomsById?.[sessionId]
  if (room === undefined) return []
  const members = new Set(room.members ?? [])
  const out = []
  for (const entry of approvals ?? []) {
    if (entry?.botId === undefined) continue
    // The group's own Session, or a member's Session that belongs to this group.
    const mine = entry.roomId === room.id || (entry.roomId === undefined && members.has(entry.botId))
    if (!mine) continue
    out.push({
      id: String(entry.id ?? ''),
      botId: entry.botId,
      name: roster?.byId?.[entry.botId]?.name ?? t('A Bot'),
      tool: String(entry.tool ?? '').trim(),
    })
  }
  return out
}

/**
 * The line a group chat shows while a member waits for an approval.
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
    h('button', {
      type: 'button', className: 'bt-group-approval-open',
      onClick: () => actions.openSession(entry.botId),
    }, t("Open {name}'s chat", { name: entry.name })))))
}
