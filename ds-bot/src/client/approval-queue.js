import { createElement as h, useState } from 'react'
import { BotMark } from './mark.js'
import { approvalChat } from './sources.js'
import { t } from './i18n.js'

// -------------------------------------------------------------------------
// The approvals a conversation waits on. DSH puts one approval card where the
// composer was, so a second request has no card of its own and an answer that lost
// a race leaves with the card that asked. DS Bot draws the whole queue there
// instead, and an answer the host no longer knows keeps its card and the reason
// until the user dismisses it (#966).

const NO_WORK = { approvals: [] }

// The approvals this conversation waits on, the oldest first.
export function approvalsOf(work, chat) {
  return (work?.approvals ?? NO_WORK.approvals)
    .filter(entry => approvalChat(entry) === chat)
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
}

// Answers that failed. The approval they answer is gone from the host's list, so
// only this window can still tell what happened to it.
export function closedApprovals(state, chat, pending = []) {
  return Object.values(state?.closed?.[chat] ?? {})
    .filter(entry => !pending.some(open => open.id === entry.approval.id))
    .sort((a, b) => a.at - b.at)
}

// What the host says when an approval it no longer knows is answered, and what a
// card whose approval another window decided keeps instead (#966).
export const APPROVAL_STALE = 'This approval is no longer open'

// The approvals the host's list dropped between two answers.
export function vanishedApprovals(prev, next) {
  const open = new Set((next?.approvals ?? []).map(entry => entry.id))
  return (prev?.approvals ?? []).filter(entry => !open.has(entry.id))
}

// A decision made in another window reaches this one only as a shorter list: the
// approval is gone before this window can answer it and be told why, so the card
// must go stale here instead of vanishing. One this window answered just goes, and
// its note in `settled` goes with it.
export function closeVanishedApprovals(state, prev, next, { at = Date.now(), message = APPROVAL_STALE } = {}) {
  const vanished = vanishedApprovals(prev, next)
  if (vanished.length === 0) return state
  const settled = { ...(state?.settled ?? {}) }
  const closed = { ...(state?.closed ?? {}) }
  let changed = false
  for (const entry of vanished) {
    if (settled[entry.id] === true) {
      delete settled[entry.id]
      changed = true
      continue
    }
    const chat = approvalChat(entry)
    if (closed[chat]?.[entry.id] !== undefined) continue
    closed[chat] = { ...(closed[chat] ?? {}), [entry.id]: { approval: entry, message, at } }
    changed = true
  }
  return changed ? { ...state, closed, settled } : state
}

export function waitingIn(work, state, chat) {
  const pending = approvalsOf(work, chat)
  return pending.length > 0 || closedApprovals(state, chat, pending).length > 0
}

// Whether the composer's place belongs to this conversation's approvals.
export function approvalCellWanted(roster, work, state, sessionId) {
  if (sessionId === undefined) return false
  // A group keeps its composer: its members' approvals are not its own card, and
  // its queue sits above the composer.
  if (roster?.roomsById?.[sessionId] !== undefined) return false
  // A pending question owns the composer's place, as it does in DSH.
  if (roster?.questions?.[sessionId] !== undefined) return false
  return waitingIn(work, state, sessionId)
}

// What the composer's place depends on. The shell's chain picks its entry on render,
// so the entry is registered again whenever this changes.
export const approvalCellKey = (work, state) => JSON.stringify([
  (work?.approvals ?? []).map(entry => entry.id),
  Object.entries(state?.closed ?? {}).map(([chat, cards]) => [chat, Object.keys(cards)]).sort(),
])

function ApprovalCard({ approval, bot, actions, error }) {
  const [busy, setBusy] = useState(false)
  const [answered, setAnswered] = useState(null)
  const answer = (choice) => {
    if (busy) return
    setBusy(true)
    void Promise.resolve(actions.answerApproval(approval.id, choice))
      .then(() => setAnswered(choice))
      .catch(failure => actions.reportApprovalFailure(approval, failure))
      .finally(() => setBusy(false))
  }
  const waiting = t('{name} is waiting for your approval', { name: bot?.name ?? t('A Bot') })
  return h('div', { className: 'bt-aq-card', role: 'group', 'aria-label': error ?? waiting },
    h('div', { className: 'bt-aq-head' },
      bot ? h(BotMark, { bot, size: 18, state: error ? 'idle' : 'alert' }) : null,
      h('span', { className: 'bt-aq-name' }, bot?.name ?? t('A Bot')),
      approval.tool ? h('span', { className: 'bt-aq-tool' }, approval.tool) : null),
    approval.detail?.text ? h('div', { className: 'bt-aq-text' }, approval.detail.text) : null,
    approval.reason ? h('div', { className: 'bt-aq-reason' }, approval.reason) : null,
    approval.detail?.code ? h('code', { className: 'bt-aq-code', title: approval.detail.code }, approval.detail.code) : null,
    error
      ? h('div', { className: 'bt-aq-closed' },
        h('span', { className: 'bt-aq-error', role: 'alert' }, error),
        h('button', { type: 'button', className: 'bt-aq-btn', onClick: () => actions.dismissApproval(approval) }, t('Dismiss')))
      : answered
        ? h('div', { className: 'bt-aq-done', role: 'status' }, t(answered === 'allow' ? 'Allowed' : 'Rejected'))
        : h('div', { className: 'bt-aq-actions' },
          h('button', { type: 'button', className: 'bt-aq-btn', disabled: busy, onClick: () => answer('reject') }, t('Reject')),
          h('button', { type: 'button', className: 'bt-aq-go', disabled: busy, onClick: () => answer('allow') }, t('Allow once'))))
}

// Every approval the conversation waits on, in the composer's place (`cell`) or
// above the composer of a group chat.
export function ApprovalQueue({ sessionId, cell, useWork, useApprovals, useRoster, actions }) {
  const roster = useRoster(value => value)
  const work = useWork(value => value ?? NO_WORK)
  const state = useApprovals(value => value)
  const room = roster.roomsById?.[sessionId]
  const chat = room ? room.id : sessionId
  const pending = approvalsOf(work, chat)
  const closed = closedApprovals(state, chat, pending)
  if (pending.length === 0 && closed.length === 0) return null
  const count = pending.length
  const many = count > 1 ? t('{count} waiting for approval', { count }) : null
  const label = count === 1
    ? t('{name} is waiting for your approval', { name: roster.byId[pending[0].botId]?.name ?? t('A Bot') })
    : many
  return h('div', { className: 'bt-aq', 'data-cell': cell || undefined, 'data-count': count, role: 'group', 'aria-label': label },
    many ? h('div', { className: 'bt-aq-count' }, many) : null,
    pending.map(approval => h(ApprovalCard, { key: approval.id, approval, bot: roster.byId[approval.botId], actions })),
    closed.map(entry => h(ApprovalCard, { key: entry.approval.id, approval: entry.approval, bot: roster.byId[entry.approval.botId], actions, error: entry.message })))
}

// The composer's place, which DSH's own card fills with a single request.
export function ApprovalCell(props) {
  return h(ApprovalQueue, { ...props, cell: true })
}

// Above a group's composer, which DSH leaves free: its members' approvals belong to
// the hidden Sessions they run in, so the group's own card never shows there.
export function ApprovalDock(props) {
  const roster = props.useRoster(value => value)
  if (roster.roomsById?.[props.sessionId] === undefined) return null
  return h(ApprovalQueue, props)
}

export const APPROVAL_CSS = `
.bt-aq{display:flex;flex-direction:column;gap:6px;box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance,0px) - var(--dsh-composer-side-clearance,0px) - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px));max-width:calc(var(--dsh-composer-card-max-width,748px) - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px));margin:0 auto 8px;padding:0 var(--dsh-composer-dock-inset,0px);flex:none}
.bt-aq[data-cell]{width:auto;max-width:var(--dsh-chat-content-width,748px);margin:0 auto;padding:8px calc(var(--dsh-composer-side-clearance,0px) + 16px) 12px}
.bt-aq-count{padding:0 2px;font-size:12px;line-height:16px;color:var(--bt-ink-3)}
.bt-aq-card{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border-radius:12px;background:var(--bt-hover);font-size:12px;line-height:17px;color:var(--bt-ink-2);animation:bt-rise .2s ease-out backwards}
.bt-aq-head{display:flex;align-items:center;gap:6px;min-width:0;font-weight:600;color:var(--bt-ink)}
.bt-aq-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-aq-tool{flex:none;font-weight:400;color:var(--bt-ink-3);font:11px/16px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.bt-aq-text{color:var(--bt-ink);overflow-wrap:anywhere}
.bt-aq-reason{overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.bt-aq-code{display:block;padding:4px 8px;border-radius:6px;background:var(--bt-main);font:11px/16px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--bt-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-aq-actions,.bt-aq-closed{display:flex;align-items:center;justify-content:flex-end;gap:6px;margin-top:4px}
.bt-aq-error{flex:1;min-width:0;color:var(--bt-danger);overflow-wrap:anywhere}
.bt-aq-done{margin-top:4px;text-align:right;color:var(--bt-ink-3)}
.bt-aq-btn,.bt-aq-go{height:28px;padding:0 12px;border:0;border-radius:999px;font:inherit;font-size:12px;cursor:pointer}
.bt-aq-btn{background:var(--bt-main);box-shadow:inset 0 0 0 .5px var(--bt-line-2);color:var(--bt-ink-2)}
.bt-aq-btn:hover{background:var(--bt-active);color:var(--bt-ink)}
.bt-aq-go{background:var(--bt-ink);color:var(--bt-main)}
.bt-aq-btn:disabled,.bt-aq-go:disabled{opacity:.5;cursor:default}
@media (prefers-reduced-motion:reduce){.bt-aq-card{animation:none}}
`
