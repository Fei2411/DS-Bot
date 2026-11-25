// The inbox (#782): one place for everything across Bots and group chats that waits on
// the user. The host derives the list (src/host/inbox.js) and every surface reads it:
// the entry at the top of the sidebar, this page, the sidebar's marks and the
// notifications. Opening an item shows the same card the chat shows, so answering here
// answers there.
import { createElement as h, useEffect, useRef, useState } from 'react'
import { BotAvatar, RoomAvatar } from './mark.js'
import { Segmented, useFlip, useMorph } from './motion.js'
import { useEscape } from './overlay-hooks.js'
import { CheckIcon, ChevronDownIcon } from './icons.js'
import { Elapsed } from './cells.js'
import { ApprovalCard, ComputerAppApprovalCard } from './member-status.js'
import { PendingQuestion } from './questions.js'
import { PendingView } from './widget-cell.js'
import { SecretCard } from './secret-card.js'
import { ConnectorCard, MailSendCard } from './connectors.js'
import { PendingHandoff } from './handoff-card.js'
import { PendingComputerHandoff } from './computer.js'
import { WorkPauseCard } from './work-pause-card.js'
import { ProposalCard } from './learning-card.js'
import { currentPart } from './text.js'
import { t } from './i18n.js'
import { INBOX_SECTIONS, inboxSummary, inboxTag } from './inbox-text.js'

const NONE = Object.freeze([])
const useNothing = () => undefined

/** The host's list, or none while it has not answered yet. */
export const inboxItems = roster => (Array.isArray(roster?.inbox?.items) ? roster.inbox.items : NONE)

// An item stops the chat it was asked in until the user answers; one from a background
// task, a proposal or something to fix does not stop the chat itself.
const blocks = item => item.group === 'decide' && item.taskId === undefined

/**
 * What waits in one chat, for the sidebar's marks: in a Bot's own chat (`botId`) or in
 * a group chat (`roomId`). `blocking` is the first item that stops it, `deferred` the
 * first that does not; the host's order puts the longest wait first.
 */
export function waitsOf(roster, { botId, roomId }) {
  const items = inboxItems(roster).filter(item => (roomId !== undefined ? item.roomId === roomId : item.roomId === undefined && item.botId === botId))
  return { blocking: items.find(blocks), deferred: items.find(item => !blocks(item)), any: items.length > 0 }
}

const LINES = {
  approval: 'Waiting for your approval', computer: 'Waiting for your approval', secret: 'Waiting for your approval',
  connector: 'Waiting for your approval', mail: 'Waiting for your approval', learning: 'Waiting for your approval',
  question: 'Waiting for your answer', view: 'Waiting for your answer',
  paused: 'Paused', 'room-paused': 'Paused',
}
/** The row's line for an item that waits, or null. */
export const waitLineOf = item => (item === undefined ? null : t(LINES[item.kind] ?? (item.group === 'fix' ? 'Needs a fix' : 'Waiting for you')))

// Original stroke-only tray on the 20 × 20 canvas (ui-standard §7).
export function InboxIcon({ size = 16 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    h('path', { d: 'M3.5 11.5L5.2 4.8A1.5 1.5 0 0 1 6.65 3.7h6.7a1.5 1.5 0 0 1 1.45 1.1l1.7 6.7' }),
    h('path', { d: 'M3.5 11.5h3.6l1.1 2h3.6l1.1-2h3.6v3.3a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5v-3.3z' }))
}

/**
 * The sidebar's entry: always in the same place, so the list under it never jumps. It
 * counts what waits; with nothing waiting it is a quiet row.
 */
export function InboxEntry({ roster, open, rail, actions }) {
  const count = roster?.inbox?.count ?? 0
  const label = count > 0 ? t('Inbox, {count} waiting for you', { count }) : t('Inbox')
  const toggle = () => (open ? actions.closeInbox?.() : actions.openInbox?.())
  if (rail) {
    return h('button', {
      type: 'button', className: 'bt-ib-rail', 'aria-label': label, title: label,
      'aria-current': open ? 'page' : undefined, 'data-has': count > 0 || undefined, onClick: toggle,
    },
    h(InboxIcon, { size: 22 }),
    count > 0 ? h('span', { className: 'bt-ib-rail-count', 'aria-hidden': true }, count > 99 ? '99+' : String(count)) : null)
  }
  return h('button', {
    type: 'button', className: 'bt-ib-entry', 'aria-label': label,
    'aria-current': open ? 'page' : undefined, 'data-has': count > 0 || undefined, onClick: toggle,
  },
  h('span', { className: 'bt-ib-entry-ico' }, h(InboxIcon, { size: 18 })),
  h('span', { className: 'bt-ib-entry-name' }, t('Inbox')),
  count > 0 ? h('span', { className: 'bt-ib-count', 'aria-hidden': true }, count > 99 ? '99+' : String(count)) : null)
}

// Answers that fit on the row, for the kinds whose card is two buttons.
const quickOf = (item, actions) => {
  if (item.kind === 'approval') return [['Reject', () => actions.answerApproval(item.ref, 'reject')], ['Allow once', () => actions.answerApproval(item.ref, 'allow')]]
  if (item.kind === 'computer') return [['Deny', () => actions.computerAppAnswer(item.ref, 'deny')], ['This time', () => actions.computerAppAnswer(item.ref, 'once')]]
  if (item.kind === 'room-paused') return [['Continue', () => actions.resumeRoomPause(item.roomId)]]
  return null
}

// The card the chat shows for this item, in place. Kinds without one get the step
// that moves them on.
function ItemCard({ item, bot, roster, actions, hooks, run }) {
  const open = () => openItem(item, actions)
  const button = (label, onClick, primary = false) => h('button', { key: label, type: 'button', className: primary ? 'bt-q-submit' : 'bt-q-btn', onClick }, t(label))
  switch (item.kind) {
    case 'approval': {
      const approval = hooks.approvals.find(entry => entry.id === item.ref)
      return approval && bot ? h(ApprovalCard, { approval, bot, actions }) : null
    }
    case 'computer': {
      const ask = hooks.asks[item.ref]
      return ask && bot ? h(ComputerAppApprovalCard, { ask, bot, actions }) : null
    }
    case 'question': {
      const question = roster.questions?.[item.sessionId]
      return question ? h(PendingQuestion, { sessionId: item.sessionId, question, actions, inline: true }) : null
    }
    case 'view': {
      const view = roster.views?.[item.sessionId]
      return view ? h(PendingView, { sessionId: item.sessionId, view, actions, inline: true }) : null
    }
    case 'secret': {
      const request = (roster.secretRequests?.[item.botId] ?? []).find(entry => entry.id === item.ref)
      return request && bot ? h(SecretCard, { sessionId: request.sessionId ?? currentPart(bot), bot, request, roster, actions, inline: true }) : null
    }
    case 'connector': {
      const request = (roster.connectorRequests?.[item.botId] ?? []).find(entry => entry.id === item.ref)
      return request && bot ? h(ConnectorCard, { sessionId: request.sessionId ?? currentPart(bot), bot, request, actions, inline: true }) : null
    }
    case 'mail': {
      const request = (roster.mailRequests?.[item.botId] ?? []).find(entry => entry.id === item.ref)
      return request && bot ? h(MailSendCard, { sessionId: request.sessionId ?? currentPart(bot), bot, request, roster, actions, inline: true }) : null
    }
    case 'handoff': {
      if (!bot) return null
      if (item.surface === 'computer') {
        const hold = hooks.computerHolds[item.botId]
        return hold ? h(PendingComputerHandoff, { sessionId: item.sessionId ?? currentPart(bot), bot, hold, actions, inline: true }) : null
      }
      const hold = hooks.browserHolds[item.botId]
      return hold ? h(PendingHandoff, { sessionId: item.sessionId ?? currentPart(bot), bot, hold, hooks: hooks.browser, actions, inline: true }) : null
    }
    case 'paused': {
      const work = hooks.paused.find(entry => entry.id === item.ref)
      return work ? h(WorkPauseCard, { work, roster, actions, inline: true }) : null
    }
    case 'room-paused':
      return h('div', { className: 'bt-q-foot' }, button('Continue', () => run(actions.resumeRoomPause(item.roomId)), true))
    // The chat's own failure card holds every fix (a key, a sign-in, another model).
    case 'blocked':
      return h('div', { className: 'bt-q-foot' }, button('Retry', () => run(actions.resume(item.botId)), true))
    case 'learning': {
      // The card answers and shows its own failure; the list follows the host.
      const proposal = (roster.learning?.[item.botId] ?? []).find(entry => entry.id === item.ref)
      return proposal ? h(ProposalCard, { proposal, actions, onFailure: () => {}, onResolved: () => {} }) : null
    }
    default:
      return h('div', { className: 'bt-q-foot' }, button('Open in chat', open, true))
  }
}

// Kinds that show a card or a step of their own here; the rest are opened in their chat.
const HERE = new Set(['approval', 'computer', 'question', 'view', 'secret', 'connector', 'mail', 'handoff', 'paused', 'room-paused', 'blocked', 'learning'])

// A card asked in a group lives in that group's chat, not in the member's own (#1623).
function openItem(item, actions) {
  actions.closeInbox?.()
  if (item.roomId !== undefined) {
    actions.openSession(item.roomId)
    if (item.kind === 'approval' || item.kind === 'computer') actions.openApproval?.(item.roomId)
    else if (item.kind === 'goal') actions.openGoal?.(item.roomId)
  } else if (item.botId !== undefined) {
    actions.openSession(item.botId)
    if (item.taskId !== undefined) actions.openTaskDeck?.(item.botId, item.taskId)
  }
}

function Row({ item, gone, open, toggle, roster, actions, hooks, rowRef }) {
  const box = useRef(null)
  useMorph(box, open ? 'open' : 'shut')
  const bot = item.botId === undefined ? undefined : roster.byId?.[item.botId]
  const room = item.roomId === undefined ? undefined : roster.roomsById?.[item.roomId]
  const who = [bot?.name, room?.name].filter(Boolean).join(' · ')
  const quick = !open && !gone ? quickOf(item, actions) : null
  const run = (promise) => { void Promise.resolve(promise).catch(error => actions.reportError?.(error, 'inbox')) }
  return h('div', { ref: box, className: 'bt-ib-row', 'data-flip': item.id, 'data-open': open || undefined, 'data-gone': gone || undefined },
    h('div', { className: 'bt-ib-head' },
      h('button', {
        ref: rowRef, type: 'button', className: 'bt-ib-sum', 'aria-expanded': open, disabled: gone,
        onClick: () => toggle(item.id),
      },
      bot && !(item.kind === 'room-paused' || item.kind === 'goal')
        ? h(BotAvatar, { bot, size: 28, badge: false, live: false })
        : room ? h(RoomAvatar, { room, roster, size: 28 }) : h('span', { className: 'bt-ib-noface' }),
      h('span', { className: 'bt-ib-copy' },
        h('span', { className: 'bt-ib-who' },
          h('span', { className: 'bt-ib-name' }, who),
          h('span', { className: 'bt-tag', 'data-group': item.group }, t(inboxTag(item)))),
        h('span', { className: 'bt-ib-text' }, inboxSummary(item, t, id => roster.byId?.[id]?.name))),
      gone
        ? h('span', { className: 'bt-ib-ok' }, h(CheckIcon), t('Handled'))
        : item.at > 0 ? h(Elapsed, { at: item.at, className: 'bt-ib-time', dot: false }) : null,
      gone ? null : h('span', { className: 'bt-ib-chev', 'aria-hidden': true }, h(ChevronDownIcon))),
      quick ? h('span', { className: 'bt-ib-quick' }, quick.map(([label, answer], index) => h('button', {
        key: label, type: 'button', className: index === quick.length - 1 ? 'bt-send bt-ib-btn' : 'bt-soft bt-soft-sm',
        onClick: () => run(answer()),
      }, t(label)))) : null),
    open && !gone
      ? h('div', { className: 'bt-ib-detail' },
          h(ItemCard, { item, bot, roster, actions, hooks, run }),
          HERE.has(item.kind)
            ? h('div', { className: 'bt-ib-acts' },
                h('button', { type: 'button', className: 'bt-ib-link', onClick: () => openItem(item, actions) }, t('Open in chat')))
            : null)
      : null)
}

// An answered item says so for a moment before it leaves, so the list does not jump
// under the pointer. Each leaving item keeps its own timer: the list changes again
// meanwhile (every save sends it), and that must not keep the item on screen.
const GONE_MS = 900
function useLeaving(items) {
  const [gone, setGone] = useState(() => new Map())
  const last = useRef(items)
  const timers = useRef(new Set())
  useEffect(() => () => { for (const timer of timers.current) clearTimeout(timer) }, [])
  useEffect(() => {
    const ids = new Set(items.map(item => item.id))
    const left = last.current.filter(item => !ids.has(item.id))
    last.current = items
    // One that is back (its answer failed) is not leaving any more.
    setGone((current) => {
      const back = [...current.keys()].filter(id => ids.has(id))
      if (back.length === 0 && left.length === 0) return current
      const next = new Map(current)
      for (const id of back) next.delete(id)
      for (const item of left) next.set(item.id, item)
      return next
    })
    if (left.length === 0) return
    const timer = setTimeout(() => {
      timers.current.delete(timer)
      setGone((current) => {
        const next = new Map(current)
        for (const item of left) if (next.get(item.id) === item) next.delete(item.id)
        return next
      })
    }, GONE_MS)
    timers.current.add(timer)
  }, [items])
  return gone
}

function Empty({ text }) {
  return h('div', { className: 'bt-ib-empty' }, h(InboxIcon, { size: 28 }), h('span', null, text))
}

/**
 * The inbox page over the conversation column. Waiting for you: the host's list in its
 * three groups, each item opening into its own card. New replies: the conversations
 * with replies not read yet; opening one reads it.
 */
export function InboxPane({ paneLeft, roster, actions, useWork, useComputer, useSessionStatus, useBotCompletions, useBrowserHolds, useBrowserTabs, useBrowserPages }) {
  const [tab, setTab] = useState('wait')
  const [who, setWho] = useState('all')
  const [open, setOpen] = useState(null)
  const list = useRef(null)
  const refs = useRef(new Map())
  useEscape(() => (open !== null ? setOpen(null) : actions.closeInbox?.()))
  const items = inboxItems(roster)
  const gone = useLeaving(items)
  const approvals = (useWork ?? useNothing)(work => work?.approvals) ?? NONE
  const paused = (useWork ?? useNothing)(work => work?.paused) ?? NONE
  const asks = (useComputer ?? useNothing)(computer => computer?.asks) ?? {}
  const computerHolds = (useComputer ?? useNothing)(computer => computer?.holds) ?? {}
  const browserHolds = (useBrowserHolds ?? useNothing)(holds => holds) ?? {}
  const hooks = { approvals, paused, asks, computerHolds, browserHolds, browser: { useBrowserTabs, useBrowserPages } }

  const shown = [...items, ...gone.values()]
    .filter((item, index, all) => all.findIndex(other => other.id === item.id) === index)
    .filter(item => who === 'all' || item.botId === who || item.roomId === who)
  const sources = []
  for (const item of items) {
    for (const id of [item.roomId, item.roomId === undefined ? item.botId : undefined]) {
      if (id !== undefined && !sources.includes(id)) sources.push(id)
    }
  }
  const nameOf = id => roster.byId?.[id]?.name ?? roster.roomsById?.[id]?.name ?? ''
  useEffect(() => { if (who !== 'all' && !sources.includes(who)) setWho('all') }, [sources.join('|')])

  // Conversations with replies not read yet: a Bot's own chat, or a group chat. A Bot's
  // chat reads the window's completions (bot-completions.js leaves out exchanges the user
  // does not see) where it has them, else the Session's own status.
  const completedBots = (useBotCompletions ?? useNothing)(map => Object.keys(map ?? {}).filter(id => map[id] === true).sort().join('|'))
  const statusBots = (useSessionStatus ?? useNothing)(map => (roster.bots ?? []).map(bot => currentPart(bot)).filter(id => map?.get?.(id)?.completionUnread === true).join('|'))
  const botUnread = (useBotCompletions ? completedBots : statusBots) ?? ''
  const roomUnread = (useSessionStatus ?? useNothing)(map => (roster.rooms ?? []).filter(room => map?.get?.(room.sessionId ?? room.id)?.completionUnread === true).map(room => room.id).join('|')) ?? ''
  const unreadParts = new Set(botUnread.split('|').filter(Boolean))
  const replies = [
    ...(roster.bots ?? []).filter(bot => unreadParts.has(currentPart(bot))).map(bot => ({ id: bot.id, bot, at: bot.lastAt ?? 0, preview: bot.preview })),
    ...roomUnread.split('|').filter(Boolean).map(id => roster.roomsById?.[id]).filter(Boolean).map(room => ({ id: room.id, room, at: room.lastAt ?? 0, preview: room.preview })),
  ].sort((a, b) => b.at - a.at)

  useFlip(list, `${tab}|${who}|${open}|${shown.map(item => item.id).join(',')}|${replies.map(entry => entry.id).join(',')}`, '[data-flip]')

  const toggle = id => setOpen(current => (current === id ? null : id))
  // ↑ ↓ (or J K) walk the rows; Enter opens one; Esc closes it, then the page.
  const onKey = (event) => {
    const step = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 }[event.key]
    if (step === undefined || event.metaKey || event.ctrlKey || event.altKey) return
    if (event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable=true],.bt-ib-detail')) return
    const ids = shown.filter(item => !gone.has(item.id)).map(item => item.id)
    if (ids.length === 0) return
    event.preventDefault()
    const at = ids.findIndex(id => refs.current.get(id) === document.activeElement)
    const next = ids[at === -1 ? 0 : Math.max(0, Math.min(ids.length - 1, at + step))]
    refs.current.get(next)?.focus()
  }
  const count = items.length

  return h('div', { className: 'bt-pane bt-ib-pane', style: { left: paneLeft } },
    h('div', { className: 'bt-ib-page', role: 'region', 'aria-label': t('Inbox'), onKeyDown: onKey },
      h('header', { className: 'bt-ib-top', 'data-window-drag': true }, h('div', { className: 'bt-ib-top-in' },
        h('h1', null, t('Inbox')),
        h(Segmented, { label: t('Inbox'), value: tab, className: 'bt-ib-seg' },
          h('button', { type: 'button', 'aria-pressed': tab === 'wait', onClick: () => setTab('wait') }, count > 0 ? `${t('Waiting for you')} ${count}` : t('Waiting for you')),
          h('button', { type: 'button', 'aria-pressed': tab === 'replies', onClick: () => setTab('replies') }, replies.length > 0 ? `${t('New replies')} ${replies.length}` : t('New replies'))),
        h('span', { className: 'bt-ib-gap' }),
        tab === 'wait' && sources.length > 1
          ? h('select', { className: 'bt-select bt-ib-who-pick', value: who, 'aria-label': t('Filter by Bot or group chat'), onChange: event => setWho(event.target.value) },
              h('option', { value: 'all' }, t('All')),
              sources.map(id => h('option', { key: id, value: id }, nameOf(id))))
          : null)),
      h('div', { ref: list, className: 'bt-ib-scroll' },
        tab === 'wait'
          ? (shown.length === 0
              ? h(Empty, { text: t('Nothing waits for you') })
              : INBOX_SECTIONS.map(([group, title]) => {
                  const rows = shown.filter(item => item.group === group).sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
                  if (rows.length === 0) return null
                  const left = rows.filter(item => !gone.has(item.id)).length
                  return h('section', { key: group, className: 'bt-ib-sec', 'data-flip': `sec-${group}` },
                    h('h3', null, t(title), left > 0 ? h('span', null, String(left)) : null),
                    h('div', { className: 'bt-set-card' }, rows.map(item => h(Row, {
                      key: item.id, item, gone: gone.has(item.id), open: open === item.id, toggle, roster, actions, hooks,
                      rowRef: (node) => { if (node) refs.current.set(item.id, node); else refs.current.delete(item.id) },
                    }))))
                }))
          : (replies.length === 0
              ? h(Empty, { text: t('No new replies') })
              : h('div', { className: 'bt-set-card bt-ib-replies' }, replies.map(entry => h('div', { key: entry.id, className: 'bt-ib-row', 'data-flip': `reply-${entry.id}` },
                  h('div', { className: 'bt-ib-head' },
                    h('button', {
                      type: 'button', className: 'bt-ib-sum',
                      onClick: () => { actions.closeInbox?.(); actions.openSession(entry.id) },
                    },
                    entry.bot ? h(BotAvatar, { bot: entry.bot, size: 28, badge: false, live: false }) : h(RoomAvatar, { room: entry.room, roster, size: 28 }),
                    h('span', { className: 'bt-ib-copy' },
                      h('span', { className: 'bt-ib-who' }, h('span', { className: 'bt-ib-name' }, (entry.bot ?? entry.room).name)),
                      entry.preview ? h('span', { className: 'bt-ib-text bt-ib-text-2' }, entry.preview) : null),
                    entry.at > 0 ? h(Elapsed, { at: entry.at, className: 'bt-ib-time', dot: false }) : null)))))))))
}

export const INBOX_CSS = `
.bt-ib-entry{display:flex;align-items:center;gap:8px;flex:none;height:40px;margin:6px 0 2px;padding:0 10px 0 8px;border:0;border-radius:12px;background:transparent;color:var(--bt-ink-2);font:inherit;font-size:14px;line-height:20px;text-align:left;cursor:pointer;transition:background-color .12s ease,color .12s ease}
.bt-ib-entry:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bt-ib-entry[aria-current]{background:var(--bt-active);color:var(--bt-ink)}
.bt-ib-entry[data-has]{color:var(--bt-ink)}
.bt-ib-entry:focus-visible,.bt-ib-rail:focus-visible,.bt-ib-sum:focus-visible,.bt-ib-link:focus-visible{outline:2px solid var(--bt-accent);outline-offset:1px}
.bt-ib-entry-ico{display:flex;align-items:center;justify-content:center;width:36px;flex:none}
.bt-ib-entry-name{flex:1;min-width:0}
.bt-ib-count{min-width:20px;height:20px;padding:0 6px;box-sizing:border-box;border-radius:999px;background:color-mix(in srgb,var(--bt-star) 22%,transparent);color:var(--bt-warn);font-size:11px;line-height:20px;font-weight:600;text-align:center;font-variant-numeric:tabular-nums}
.bt-ib-rail{position:relative;display:flex;align-items:center;justify-content:center;width:56px;height:56px;flex:none;border:0;border-radius:16px;background:transparent;color:var(--bt-ink-2);cursor:pointer;transition:background-color .12s ease,color .12s ease}
.bt-ib-rail:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bt-ib-rail[aria-current]{background:var(--bt-active);color:var(--bt-ink)}
.bt-ib-rail-count{position:absolute;top:6px;right:6px;min-width:16px;height:16px;padding:0 4px;box-sizing:border-box;border-radius:999px;corner-shape:round;background:color-mix(in srgb,var(--bt-star) 22%,var(--bt-sidebar));color:var(--bt-warn);font-size:10px;line-height:16px;font-weight:600;font-variant-numeric:tabular-nums;box-shadow:0 0 0 1.5px var(--bt-sidebar)}
.bt-ib-pane{z-index:44}
.bt-ib-page{flex:1;min-width:0;display:flex;flex-direction:column;background:var(--bt-main);color:var(--bt-ink);font-family:var(--bt-font)}
.bt-ib-top{height:56px;padding:6px 28px 0;flex:none;box-sizing:border-box}
.bt-ib-top-in{display:flex;align-items:center;gap:12px;height:100%;max-width:820px;margin:0 auto}
.bt-ib-top h1{margin:0;font-size:15px;line-height:20px;font-weight:600}
.bt-ib-seg{flex:none}
.bt-ib-seg button{height:28px;padding:0 12px;font-size:13px;white-space:nowrap;font-variant-numeric:tabular-nums}
.bt-ib-gap{flex:1}
.bt-ib-who-pick{width:auto;min-width:120px;max-width:220px;height:30px}
.bt-ib-scroll{flex:1;min-height:0;overflow:auto;padding:8px 28px 28px;display:flex;flex-direction:column;gap:20px}
.bt-ib-scroll>*{width:100%;max-width:820px;margin:0 auto;box-sizing:border-box}
.bt-ib-sec h3{display:flex;gap:6px;margin:0 0 8px 4px;font-size:13px;line-height:18px;font-weight:600;color:var(--bt-ink-2)}
.bt-ib-sec h3 span{color:var(--bt-ink-3);font-weight:500;font-variant-numeric:tabular-nums}
.bt-ib-row{position:relative}
.bt-ib-row+.bt-ib-row{border-top:1px solid var(--bt-line)}
.bt-ib-row[data-gone]{opacity:.6;transition:opacity .16s ease}
.bt-ib-head{position:relative;display:flex;align-items:center}
.bt-ib-sum{flex:1;min-width:0;display:flex;align-items:center;gap:10px;min-height:56px;padding:9px 12px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;transition:background-color .12s ease}
.bt-ib-sum:hover:not(:disabled){background:var(--bt-hover)}
.bt-ib-sum:disabled{cursor:default}
.bt-ib-row[data-open] .bt-ib-sum:hover{background:transparent}
.bt-ib-noface{width:28px;height:28px;flex:none}
.bt-ib-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.bt-ib-who{display:flex;align-items:center;gap:6px;min-width:0;font-size:13px;line-height:18px;font-weight:500}
.bt-ib-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-ib-who .bt-tag[data-group=decide]{background:color-mix(in srgb,var(--bt-star) 16%,transparent);color:var(--bt-warn)}
.bt-ib-who .bt-tag[data-group=fix]{background:color-mix(in srgb,var(--bt-danger) 10%,transparent);color:var(--bt-danger)}
.bt-ib-text{font-size:13px;line-height:18px;color:var(--bt-ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-ib-text-2{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.bt-ib-time{flex:none;font-size:11px;line-height:16px;color:var(--bt-ink-3);font-variant-numeric:tabular-nums}
.bt-ib-chev{flex:none;display:flex;color:var(--bt-ink-3);transition:rotate .2s ease}
.bt-ib-row[data-open] .bt-ib-chev{rotate:180deg}
.bt-ib-ok{flex:none;display:inline-flex;align-items:center;gap:4px;font-size:12px;line-height:16px;color:var(--bt-green);font-weight:500}
.bt-ib-ok svg{width:14px;height:14px}
.bt-ib-quick{position:absolute;right:12px;top:50%;translate:0 -50%;display:flex;gap:6px;padding-left:24px;background:linear-gradient(90deg,transparent,var(--bt-card) 20px);opacity:0;pointer-events:none;transition:opacity .12s ease}
.bt-ib-head:hover .bt-ib-quick,.bt-ib-head:focus-within .bt-ib-quick{opacity:1;pointer-events:auto}
.bt-ib-head:hover .bt-ib-quick{background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--bt-card),var(--bt-hover)) 20px)}
.bt-ib-btn{height:28px;padding:0 12px;font-size:12px;font-weight:500}
.bt-ib-detail{display:flex;flex-direction:column;gap:8px;padding:0 12px 12px 50px;animation:bt-veil-in .2s ease-out backwards}
.bt-ib-detail .bt-q-inline,.bt-ib-detail .bt-mw-card{margin:0}
.bt-ib-acts{display:flex;align-items:center;gap:6px}
.bt-ib-link{padding:0;border:0;background:none;color:var(--bt-ink-2);font:inherit;font-size:12px;line-height:16px;cursor:pointer;text-decoration:underline;text-decoration-color:var(--bt-line-2);text-underline-offset:3px}
.bt-ib-link:hover{color:var(--bt-ink)}
.bt-ib-empty{display:flex;flex-direction:column;align-items:center;gap:12px;margin-top:120px!important;font-size:13px;line-height:18px;color:var(--bt-ink-3)}
`
