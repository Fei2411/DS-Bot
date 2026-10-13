import { createElement as h, useEffect, useState } from 'react'
import { BotMark, toolState } from './mark.js'
import { Shimmer, workPhrase } from './cells.js'
import { elapsedLabel } from './activity-row.js'
import { t } from './i18n.js'

// -------------------------------------------------------------------------
// What a group's members are doing: a line above the composer while any of them is
// busy, in any of their chats, and the same per member in the details panel, where
// the approvals their group turns wait on are answered.

const NO_WORK = { bots: {}, approvals: [] }

export function memberWork(room, work = NO_WORK) {
  return room.members.map((id) => {
    const approvals = (work.approvals ?? []).filter(entry => entry.botId === id)
    const doing = work.bots?.[id]
    return { id, approvals, doing, state: approvals.length > 0 ? 'ask' : doing ? 'work' : 'idle' }
  })
}

// The busy members, those waiting for an approval first.
export function busyMembers(room, work, roster) {
  const busy = memberWork(room, work).filter(entry => entry.state !== 'idle' && roster.byId[entry.id])
  return [...busy.filter(entry => entry.state === 'ask'), ...busy.filter(entry => entry.state === 'work')]
    .map(entry => ({ ...entry, bot: roster.byId[entry.id] }))
}

export function summaryText(busy) {
  const asks = busy.filter(entry => entry.state === 'ask')
  const workers = busy.filter(entry => entry.state === 'work')
  const names = asks.slice(0, 2).map(entry => entry.bot.name)
  const waiting = asks.length === 0 ? ''
    : asks.length === 1 ? t('{name} is waiting for your approval', { name: names[0] })
      : asks.length === 2 ? t('{first} and {second} are waiting for your approval', { first: names[0], second: names[1] })
        : t('{first}, {second} and {count} more are waiting for your approval', { first: names[0], second: names[1], count: asks.length - 2, total: asks.length })
  const first = workers[0]
  const doing = first ? `${first.bot.name} · ${workPhrase(first.doing.tool)}…${workers.length > 1 ? ` +${workers.length - 1}` : ''}` : ''
  return { waiting, doing }
}

function Face({ entry, size }) {
  return h('span', { className: 'bt-mw-face', 'data-ask': entry.state === 'ask' || undefined },
    h(BotMark, { bot: entry.bot, size, state: entry.state === 'ask' ? 'alert' : toolState(entry.doing?.tool ?? '') }))
}

// The line above a group's composer; it opens the details panel.
export function MemberDock({ sessionId, useRoster, useWork, actions }) {
  const roster = useRoster(value => value)
  const work = useWork(value => value)
  const room = roster.roomsById[sessionId]
  if (!room) return null
  const busy = busyMembers(room, work, roster)
  if (busy.length === 0) return null
  const { waiting, doing } = summaryText(busy)
  return h('div', { className: 'bt-event bt-mw-dock' },
    h('button', { type: 'button', className: 'bt-event-whole bt-mw-line', 'aria-label': [waiting, doing].filter(Boolean).join(' · '), onClick: () => actions.showDetails(sessionId) },
      h('span', { className: 'bt-mw-stack', 'aria-hidden': true }, busy.slice(0, 4).map(entry => h(Face, { key: entry.id, entry, size: 16 }))),
      waiting ? h('span', { className: 'bt-mw-ask' }, waiting) : null,
      waiting && doing ? h('span', { 'aria-hidden': true }, '·') : null,
      doing ? h('span', { className: 'bt-event-name' }, h(Shimmer, null, doing)) : null))
}

function useNow(active) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!active) return undefined
    const timer = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

const since = (now, at) => (typeof at === 'number' && now - at >= 60000 ? ` · ${elapsedLabel(now - at)}` : '')

function ApprovalCard({ approval, bot, actions }) {
  const [busy, setBusy] = useState(false)
  const answer = (choice) => {
    setBusy(true)
    void Promise.resolve(actions.answerApproval(approval.id, choice))
      .catch(error => actions.reportError(error, 'approval'))
      .finally(() => setBusy(false))
  }
  return h('div', { className: 'bt-mw-card', role: 'group', 'aria-label': t('{name} is waiting for your approval', { name: bot.name }) },
    h('div', { className: 'bt-mw-tool' }, approval.tool),
    approval.detail?.text ? h('div', { className: 'bt-mw-text' }, approval.detail.text) : null,
    approval.reason ? h('div', { className: 'bt-mw-reason' }, approval.reason) : null,
    approval.detail?.code ? h('code', { className: 'bt-mw-code', title: approval.detail.code }, approval.detail.code) : null,
    approval.answerable
      ? h('div', { className: 'bt-mw-actions' },
        h('button', { type: 'button', className: 'bt-q-btn', disabled: busy, onClick: () => answer('reject') }, t('Reject')),
        h('button', { type: 'button', className: 'bt-q-submit', disabled: busy, onClick: () => answer('allow') }, t('Allow once')))
      : h('div', { className: 'bt-mw-actions' },
        h('button', { type: 'button', className: 'bt-q-btn', onClick: () => actions.openSession(bot.id) }, t("Open {name}'s chat", { name: bot.name }))))
}

// Under a member's row in the group's details: what it is doing, and where.
export function MemberWork({ entry, bot, room, roster, actions, now }) {
  if (entry.state === 'ask') {
    return h('div', { className: 'bt-mw-member' },
      h('div', { className: 'bt-mw-state bt-mw-ask' }, `${t('Waiting for your approval')}${since(now, entry.approvals[0].at)}`),
      entry.approvals.map(approval => h(ApprovalCard, { key: approval.id, approval, bot, actions })))
  }
  if (entry.state !== 'work') return null
  const where = entry.doing.roomId === room.id ? ''
    : entry.doing.roomId ? t('in {name}', { name: roster.roomsById[entry.doing.roomId]?.name ?? t('a group chat') })
      : t('in its own chat')
  return h('div', { className: 'bt-mw-member' },
    h('div', { className: 'bt-mw-state' }, h(Shimmer, null, `${workPhrase(entry.doing.tool)}…`), where ? ` ${where}` : '', since(now, entry.doing.since)))
}

export function useMemberWork(room, useWork) {
  const work = useWork?.(value => value) ?? NO_WORK
  const entries = room ? memberWork(room, work) : []
  const now = useNow(entries.some(entry => entry.state !== 'idle'))
  return { entries, now }
}

export const MEMBER_CSS = `
.bt-event.bt-mw-dock{margin:0 0 6px;pointer-events:none}
.bt-mw-dock>button{pointer-events:auto;animation:bt-mw-in .32s cubic-bezier(.23,1,.32,1) backwards}
.bt-mw-line{gap:6px!important}
.bt-mw-stack{display:inline-flex;align-items:center;flex:none;line-height:0}
.bt-mw-stack>*+*{margin-left:-4px}
.bt-mw-face{position:relative;display:inline-flex;flex:none;border-radius:50%}
.bt-mw-stack .bt-mw-face{box-shadow:0 0 0 1.5px var(--bt-main,#fff)}
.bt-mw-face[data-ask]::after{content:"";position:absolute;right:-2px;bottom:-2px;width:7px;height:7px;border-radius:50%;background:#e3a008;box-shadow:0 0 0 1.5px var(--bt-main,#fff)}
.bt-mw-ask{color:#b7791f;flex:none;white-space:nowrap}
body[data-ds-dark-theme] .bt-mw-ask{color:#f0b84a}
.bt-mw-member{padding:0 6px 8px 42px;display:flex;flex-direction:column;gap:6px}
.bt-mw-state{font-size:12px;line-height:16px;color:var(--bt-ink-2);margin-top:-4px}
.bt-mw-card{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border-radius:12px;background:var(--bt-hover);font-size:12px;line-height:17px;color:var(--bt-ink-2)}
.bt-mw-tool{font-weight:600;color:var(--bt-ink)}
.bt-mw-text{color:var(--bt-ink);overflow-wrap:anywhere}
.bt-mw-reason{overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.bt-mw-code{display:block;font:11px/16px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--bt-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-mw-actions{display:flex;justify-content:flex-end;gap:6px;margin-top:4px}
.bt-mw-actions>button{height:28px;padding:0 12px;font-size:12px}
.bt-mw-actions>button:disabled{opacity:.5;cursor:default}
@keyframes bt-mw-in{from{opacity:0;transform:translateY(4px)}}
@media (prefers-reduced-motion:reduce){.bt-mw-dock>button{animation:none}}
`
