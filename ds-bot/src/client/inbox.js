// The inbox: one place for everything across Bots and group chats that waits on the
// user. The host derives the list (src/host/inbox.js) and every surface reads it: the
// sidebar trigger beside New…, this page, the sidebar's marks and the notifications.
// Opening an item shows the same card the chat shows, so answering here answers there.
import { createElement as h, useEffect, useRef, useState } from 'react'
import { BotAvatar, RoomAvatar } from './mark.js'
import { SPRING_SHAPE, SPRING_TAP, Segmented, useFlip, useMorph } from './motion.js'
import { useEscape } from './overlay-hooks.js'
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, CloseIcon } from './icons.js'
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
 * The sidebar's entry: a quiet icon button beside New… in both the open sidebar and
 * the rail, carrying a small count badge only while something waits.
 */
export function InboxEntry({ roster, open, rail, actions }) {
  const count = roster?.inbox?.count ?? 0
  const label = count > 0 ? t('Inbox, {count} waiting for you', { count }) : t('Inbox')
  const toggle = () => (open ? actions.closeInbox?.() : actions.openInbox?.())
  return h('button', {
    type: 'button', className: 'bt-round bt-ib-trigger', 'aria-label': label, title: label,
    'aria-current': open ? 'page' : undefined, 'data-has': count > 0 || undefined, 'data-rail': rail || undefined, onClick: toggle,
  },
  h(InboxIcon, { size: 16 }),
  count > 0 ? h('span', { className: 'bt-ib-badge', 'aria-hidden': true }, count > 99 ? '99+' : String(count)) : null)
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
function ItemCard({ item, bot, roster, actions, hooks, run, busy }) {
  const open = () => openItem(item, actions)
  const button = (label, onClick, primary = false, disabled = false) => h('button', { key: label, type: 'button', className: primary ? 'bt-q-submit' : 'bt-q-btn', disabled, onClick }, t(label))
  // Taking over a browser or computer opens the right panel, which sits below the inbox
  // pane (z 40 vs 44), so dismiss the inbox and focus the Bot's chat first.
  const takeoverActions = bot ? {
    ...actions,
    openBrowser: (id) => {
      actions.openSession?.(bot.id)
      actions.closeInbox?.()
      return actions.openBrowser?.(id)
    },
    showDetails: (id, tab) => {
      actions.openSession?.(bot.id)
      actions.closeInbox?.()
      return actions.showDetails?.(id, tab)
    },
  } : actions
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
      return request && bot ? h(ConnectorCard, { sessionId: request.sessionId ?? currentPart(bot), bot, request, roster, actions, inline: true }) : null
    }
    case 'mail': {
      const request = (roster.mailRequests?.[item.botId] ?? []).find(entry => entry.id === item.ref)
      return request && bot ? h(MailSendCard, { sessionId: request.sessionId ?? currentPart(bot), bot, request, roster, actions, inline: true }) : null
    }
    case 'handoff': {
      if (!bot) return null
      if (item.surface === 'computer') {
        const hold = hooks.computerHolds[item.botId]
        return hold ? h(PendingComputerHandoff, { sessionId: item.sessionId ?? currentPart(bot), bot, hold, actions: takeoverActions, inline: true }) : null
      }
      const hold = hooks.browserHolds[item.botId]
      return hold ? h(PendingHandoff, { sessionId: item.sessionId ?? currentPart(bot), bot, hold, hooks: hooks.browser, actions: takeoverActions, inline: true }) : null
    }
    case 'paused': {
      const work = hooks.paused.find(entry => entry.id === item.ref)
      return work ? h(WorkPauseCard, { work, roster, actions, inline: true }) : null
    }
    case 'room-paused':
      return h('div', { className: 'bt-q-foot' }, button('Continue', () => run(() => actions.resumeRoomPause(item.roomId)), true, busy))
    // The chat's own failure card holds every fix (a key, a sign-in, another model).
    case 'blocked':
      return h('div', { className: 'bt-q-foot' }, button('Retry', () => run(() => actions.resume(item.botId)), true, busy))
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

// A card asked in a group lives in that group's chat, not in the member's own.
function openItem(item, actions) {
  if (item.roomId !== undefined) {
    actions.openSession(item.roomId)
    actions.closeInbox?.()
    if (item.taskId !== undefined) actions.openTaskDeck?.(item.roomId, item.taskId)
    else if (item.kind === 'approval' || item.kind === 'computer') actions.openApproval?.(item.roomId)
    else if (item.kind === 'goal') actions.openGoal?.(item.roomId)
  } else if (item.botId !== undefined) {
    actions.openSession(item.botId)
    actions.closeInbox?.()
    if (item.taskId !== undefined) actions.openTaskDeck?.(item.botId, item.taskId)
  } else {
    actions.closeInbox?.()
  }
}

function Row({ item, gone, open, toggle, roster, actions, hooks, rowRef }) {
  const box = useRef(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  useMorph(box, open ? 'open' : 'shut')
  const bot = item.botId === undefined ? undefined : roster.byId?.[item.botId]
  const room = item.roomId === undefined ? undefined : roster.roomsById?.[item.roomId]
  const who = [bot?.name, room?.name].filter(Boolean).join(' · ')
  const summary = inboxSummary(item, t, id => roster.byId?.[id]?.name)
  const quick = !open && !gone ? quickOf(item, actions) : null
  const run = (make) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    void Promise.resolve().then(make)
      .catch(error => actions.reportError?.(error, 'inbox'))
      .finally(() => { busyRef.current = false; setBusy(false) })
  }
  return h('div', { ref: box, className: 'bt-ib-row', 'data-flip': item.id, 'data-open': open || undefined, 'data-gone': gone || undefined },
    h('div', { className: 'bt-ib-head' },
      h('button', {
        ref: rowRef, type: 'button', className: 'bt-ib-sum', 'aria-expanded': open, disabled: gone,
        onClick: () => toggle(item.id),
      },
      bot && !(item.kind === 'room-paused' || item.kind === 'goal')
        ? h(BotAvatar, { bot, size: 36, badge: false, live: false })
        : room ? h(RoomAvatar, { room, roster, size: 36 }) : h('span', { className: 'bt-ib-noface' }),
      h('span', { className: 'bt-ib-copy' },
        h('span', { className: 'bt-ib-title' }, summary || who),
        h('span', { className: 'bt-ib-meta' },
          who ? h('span', { className: 'bt-ib-name' }, who) : null,
          who ? h('span', { className: 'bt-ib-sep', 'aria-hidden': true }, '·') : null,
          h('span', { className: 'bt-ib-kind', 'data-group': item.group }, t(inboxTag(item))),
          !gone && item.at > 0 ? h('span', { className: 'bt-ib-sep', 'aria-hidden': true }, '·') : null,
          !gone && item.at > 0 ? h(Elapsed, { at: item.at, className: 'bt-ib-time', dot: false }) : null))),
      h('span', { className: 'bt-ib-tail' },
        gone
          ? h('span', { className: 'bt-ib-ok' }, h(CheckIcon), t('Handled'))
          : quick
            ? h('span', { className: 'bt-ib-quick' }, quick.map(([label, answer], index) => h('button', {
                key: label, type: 'button', className: index === quick.length - 1 ? 'bt-send bt-ib-btn' : 'bt-soft bt-soft-sm',
                disabled: busy, onClick: () => run(answer),
              }, t(label))))
            : null,
        gone ? null : h('button', {
          type: 'button', className: 'bt-ib-chev', tabIndex: -1, 'aria-hidden': true,
          onClick: () => toggle(item.id),
        }, h(ChevronDownIcon)))),
    open && !gone
      ? h('div', { className: 'bt-ib-detail' },
          h(ItemCard, { item, bot, roster, actions, hooks, run, busy }),
          HERE.has(item.kind)
            ? h('div', { className: 'bt-ib-acts' },
                h('button', { type: 'button', className: 'bt-ib-link', onClick: () => openItem(item, actions) },
                  t('Open in chat'), h(ChevronRightIcon)))
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
  const ids = new Set(items.map(item => item.id))
  const leftNow = last.current.filter(item => !ids.has(item.id))
  const effective = (() => {
    const back = [...gone.keys()].filter(id => ids.has(id))
    if (back.length === 0 && leftNow.length === 0) return gone
    const next = new Map(gone)
    for (const id of back) next.delete(id)
    for (const item of leftNow) next.set(item.id, item)
    return next
  })()
  useEffect(() => {
    const currentIds = new Set(items.map(item => item.id))
    const left = last.current.filter(item => !currentIds.has(item.id))
    last.current = items
    // One that is back (its answer failed) is not leaving any more.
    setGone((current) => {
      const back = [...current.keys()].filter(id => currentIds.has(id))
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
  return effective
}

function Empty({ text }) {
  return h('div', { className: 'bt-ib-empty' },
    h('span', { className: 'bt-ib-empty-mark', 'aria-hidden': true }, h(InboxIcon, { size: 22 })),
    h('span', { className: 'bt-ib-empty-text' }, text))
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
  const paneRef = useRef(null)
  const list = useRef(null)
  const refs = useRef(new Map())
  useEffect(() => {
    const opener = typeof document !== 'undefined' ? document.activeElement : null
    paneRef.current?.focus?.({ preventScroll: true })
    return () => {
      if (typeof document === 'undefined' || !opener || typeof opener.focus !== 'function' || opener.isConnected === false) return
      const active = document.activeElement
      if (!active || active === document.body || paneRef.current?.contains?.(active)) {
        opener.focus({ preventScroll: true })
      }
    }
  }, [])
  const items = inboxItems(roster)
  const gone = useLeaving(items)
  const approvals = (useWork ?? useNothing)(work => work?.approvals) ?? NONE
  const paused = (useWork ?? useNothing)(work => work?.paused) ?? NONE
  const asks = (useComputer ?? useNothing)(computer => computer?.asks) ?? {}
  const computerHolds = (useComputer ?? useNothing)(computer => computer?.holds) ?? {}
  const browserHolds = (useBrowserHolds ?? useNothing)(holds => holds) ?? {}
  const hooks = { approvals, paused, asks, computerHolds, browserHolds, browser: { useBrowserTabs, useBrowserPages } }

  const visible = [...items, ...gone.values()]
    .filter((item, index, all) => all.findIndex(other => other.id === item.id) === index)
  const shown = visible.filter(item => who === 'all' || item.botId === who || item.roomId === who)
  const sources = []
  for (const item of visible) {
    for (const id of [item.roomId, item.roomId === undefined ? item.botId : undefined]) {
      if (id !== undefined && !sources.includes(id)) sources.push(id)
    }
  }
  const nameOf = id => roster.byId?.[id]?.name ?? roster.roomsById?.[id]?.name ?? ''
  useEffect(() => { if (who !== 'all' && !sources.includes(who)) setWho('all') }, [sources.join('|')])
  const visibleOpen = tab === 'wait' && open !== null && shown.some(item => item.id === open && !gone.has(item.id)) ? open : null
  useEffect(() => { if (open !== null && visibleOpen === null) setOpen(null) }, [open, visibleOpen])
  useEscape(() => (visibleOpen !== null ? setOpen(null) : actions.closeInbox?.()))

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
    h('div', { ref: paneRef, tabIndex: -1, className: 'bt-ib-page', role: 'region', 'aria-label': t('Inbox'), onKeyDown: onKey },
      h('header', { className: 'bt-ib-top', 'data-window-drag': true },
        h('div', { className: 'bt-ib-top-in' },
          h('div', { className: 'bt-ib-bar' },
            h('h1', null, t('Inbox')),
            h('button', { type: 'button', className: 'bt-icon-btn bt-ib-close', 'aria-label': t('Close'), title: t('Close'), onClick: () => actions.closeInbox?.() }, h(CloseIcon))),
          h('div', { className: 'bt-ib-controls' },
            h(Segmented, { label: t('Inbox'), value: tab, className: 'bt-ib-seg' },
              h('button', { type: 'button', 'aria-pressed': tab === 'wait', onClick: () => setTab('wait') },
                t('Waiting for you'), count > 0 ? h('span', { className: 'bt-ib-tab-n' }, String(count)) : null),
              h('button', { type: 'button', 'aria-pressed': tab === 'replies', onClick: () => setTab('replies') },
                t('New replies'), replies.length > 0 ? h('span', { className: 'bt-ib-tab-n' }, String(replies.length)) : null)),
            tab === 'wait' && sources.length > 1
              ? h('div', { className: 'bt-ib-pills', role: 'group', 'aria-label': t('Filter by Bot or group chat') },
                  h('button', {
                    type: 'button', className: 'bt-ib-pill', 'aria-pressed': who === 'all',
                    onClick: () => setWho('all'),
                  }, t('All')),
                  sources.map((id) => {
                    const sourceBot = roster.byId?.[id]
                    const sourceRoom = roster.roomsById?.[id]
                    return h('button', {
                      key: id, type: 'button', className: 'bt-ib-pill', 'aria-pressed': who === id,
                      onClick: () => setWho(current => (current === id ? 'all' : id)),
                    },
                    sourceBot ? h(BotAvatar, { bot: sourceBot, size: 16, badge: false, live: false })
                      : sourceRoom ? h(RoomAvatar, { room: sourceRoom, roster, size: 16 }) : null,
                    h('span', null, nameOf(id)))
                  }))
              : null))),
      h('div', { ref: list, className: 'bt-ib-scroll' },
        tab === 'wait'
          ? (shown.length === 0
              ? h(Empty, { text: t('Nothing waits for you') })
              : INBOX_SECTIONS.map(([group, title]) => {
                  const rows = shown.filter(item => item.group === group).sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
                  if (rows.length === 0) return null
                  const left = rows.filter(item => !gone.has(item.id)).length
                  return h('section', { key: group, className: 'bt-ib-sec', 'data-flip': `sec-${group}` },
                    h('h3', null,
                      h('span', { className: 'bt-ib-dot', 'data-group': group, 'aria-hidden': true }),
                      t(title),
                      left > 0 ? h('span', { className: 'bt-ib-sec-n' }, String(left)) : null),
                    h('div', { className: 'bt-ib-list' }, rows.map(item => h(Row, {
                      key: item.id, item, gone: gone.has(item.id), open: open === item.id, toggle, roster, actions, hooks,
                      rowRef: (node) => { if (node) refs.current.set(item.id, node); else refs.current.delete(item.id) },
                    }))))
                }))
          : (replies.length === 0
              ? h(Empty, { text: t('No new replies') })
              : h('div', { className: 'bt-ib-list bt-ib-replies' }, replies.map(entry => h('div', { key: entry.id, className: 'bt-ib-row', 'data-flip': `reply-${entry.id}` },
                  h('div', { className: 'bt-ib-head' },
                    h('button', {
                      type: 'button', className: 'bt-ib-sum',
                      onClick: () => { actions.openSession(entry.id); actions.closeInbox?.() },
                    },
                    entry.bot ? h(BotAvatar, { bot: entry.bot, size: 36, badge: false, live: false }) : h(RoomAvatar, { room: entry.room, roster, size: 36 }),
                    h('span', { className: 'bt-ib-copy' },
                      h('span', { className: 'bt-ib-reply-top' },
                        h('span', { className: 'bt-ib-unread-dot', 'aria-hidden': true }),
                        h('span', { className: 'bt-ib-name' }, (entry.bot ?? entry.room).name)),
                      entry.preview ? h('span', { className: 'bt-ib-preview' }, entry.preview) : null)),
                    h('span', { className: 'bt-ib-tail' },
                      entry.at > 0 ? h(Elapsed, { at: entry.at, className: 'bt-ib-time', dot: false }) : null,
                      h('span', { className: 'bt-ib-go', 'aria-hidden': true }, h(ChevronRightIcon)))))))))))
}

export const INBOX_CSS = `
.bt-ib-trigger{position:relative}
.bt-ib-trigger[data-has]{color:var(--bt-ink)}
.bt-side-top .bt-ib-trigger[aria-current=page],.bt-leftcol-foot-rail .bt-ib-trigger[aria-current=page]{background:var(--bt-active);color:var(--bt-ink)}
.bt-ib-badge{position:absolute;top:-1px;right:-2px;min-width:15px;height:15px;padding:0 4px;box-sizing:border-box;border-radius:999px;corner-shape:round;background:var(--bt-warn);color:var(--bt-main);font-size:10px;line-height:15px;font-weight:600;text-align:center;font-variant-numeric:tabular-nums;box-shadow:0 0 0 1.5px var(--bt-sidebar);pointer-events:none}
.bt-ib-trigger[data-rail] .bt-ib-badge{top:-3px;right:-3px;min-width:16px;height:16px;line-height:16px}
.bt-ib-pane{z-index:44}
.bt-ib-page{flex:1;min-width:0;display:flex;flex-direction:column;background:var(--bt-main);color:var(--bt-ink);font-family:var(--bt-font)}
.bt-ib-page:focus{outline:none}
.bt-ib-top{padding:28px 32px 14px;flex:none;box-sizing:border-box}
.bt-ib-top-in{display:flex;flex-direction:column;gap:14px;max-width:720px;margin:0 auto}
.bt-ib-bar{display:flex;align-items:center;justify-content:space-between;gap:12px}
.bt-ib-bar h1{margin:0;font-size:22px;line-height:28px;font-weight:600;letter-spacing:-.02em}
.bt-ib-close{flex:none;color:var(--bt-ink-2)}
.bt-ib-controls{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.bt-ib-seg{flex:none}
.bt-ib-seg button{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;font-size:13px;white-space:nowrap}
.bt-ib-tab-n{font-size:11px;line-height:16px;font-weight:600;color:var(--bt-ink-3);font-variant-numeric:tabular-nums}
.bt-ib-seg button[aria-pressed=true] .bt-ib-tab-n{color:var(--bt-ink-2)}
.bt-ib-pills{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.bt-ib-pill{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 10px;border:1px solid var(--bt-line);border-radius:999px;background:transparent;color:var(--bt-ink-2);font:inherit;font-size:12px;line-height:16px;font-weight:500;cursor:pointer;white-space:nowrap;transition:background-color .12s ease,border-color .12s ease,color .12s ease,transform ${SPRING_TAP.duration}ms ${SPRING_TAP.easing}}
.bt-ib-pill:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bt-ib-pill:active{transform:scale(.96)}
.bt-ib-pill[aria-pressed=true]{background:var(--bt-active);border-color:transparent;color:var(--bt-ink)}
.bt-ib-pill:focus-visible,.bt-ib-sum:focus-visible,.bt-ib-link:focus-visible{outline:2px solid var(--bt-accent);outline-offset:1px}
.bt-ib-scroll{flex:1;min-height:0;overflow:auto;padding:8px 32px 36px;display:flex;flex-direction:column;gap:24px}
.bt-ib-scroll>*{width:100%;max-width:720px;margin:0 auto;box-sizing:border-box}
.bt-ib-sec h3{display:flex;align-items:center;gap:7px;margin:0 0 10px 2px;font-size:12px;line-height:16px;font-weight:600;color:var(--bt-ink-2)}
.bt-ib-dot{width:6px;height:6px;border-radius:50%;corner-shape:round;flex:none;background:var(--bt-ink-3)}
.bt-ib-dot[data-group=decide]{background:var(--bt-star)}
.bt-ib-dot[data-group=fix]{background:var(--bt-danger)}
.bt-ib-dot[data-group=suggest]{background:var(--bt-accent)}
.bt-ib-sec-n{color:var(--bt-ink-3);font-weight:500;font-variant-numeric:tabular-nums}
.bt-ib-list{display:flex;flex-direction:column;gap:8px}
.bt-ib-row{position:relative;border-radius:12px;background:var(--bt-card);border:1px solid var(--bt-line);box-shadow:var(--bt-card-shadow);overflow:clip;transition:border-color .12s ease,background-color .12s ease,opacity .16s ease}
.bt-ib-row:hover:not([data-gone]):not([data-open]){border-color:var(--bt-line-2)}
.bt-ib-row[data-open]{border-color:color-mix(in srgb,var(--bt-accent) 32%,var(--bt-line-2))}
.bt-ib-row[data-gone]{opacity:.55}
.bt-ib-head{display:flex;align-items:center;gap:8px;padding-right:12px}
.bt-ib-sum{flex:1;min-width:0;display:flex;align-items:center;gap:12px;min-height:62px;padding:12px 4px 12px 14px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.bt-ib-sum:disabled{cursor:default}
.bt-ib-noface{width:36px;height:36px;flex:none}
.bt-ib-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.bt-ib-title{font-size:14px;line-height:20px;font-weight:500;color:var(--bt-ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-ib-meta{display:flex;align-items:center;gap:6px;min-width:0;font-size:12px;line-height:16px;color:var(--bt-ink-2)}
.bt-ib-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-ib-sep{flex:none;color:var(--bt-ink-3)}
.bt-ib-kind{flex:none;font-weight:500;color:var(--bt-ink-2)}
.bt-ib-kind[data-group=decide]{color:var(--bt-warn)}
.bt-ib-kind[data-group=fix]{color:var(--bt-danger)}
.bt-ib-kind[data-group=suggest]{color:var(--bt-accent)}
.bt-ib-time{flex:none;font-size:12px;line-height:16px;color:var(--bt-ink-3);font-variant-numeric:tabular-nums}
.bt-ib-tail{flex:none;display:flex;align-items:center;gap:6px}
.bt-ib-quick{display:flex;align-items:center;gap:6px}
.bt-ib-btn{height:28px;padding:0 12px;font-size:12px;font-weight:500}
.bt-ib-chev{flex:none;width:28px;height:28px;border:0;border-radius:8px;background:transparent;color:var(--bt-ink-3);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;transition:background-color .12s ease,color .12s ease,rotate ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing}}
.bt-ib-chev:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bt-ib-row[data-open] .bt-ib-chev{rotate:180deg;color:var(--bt-ink-2)}
.bt-ib-ok{flex:none;display:inline-flex;align-items:center;gap:4px;padding-right:4px;font-size:12px;line-height:16px;color:var(--bt-green);font-weight:500}
.bt-ib-ok svg{width:14px;height:14px}
.bt-ib-detail{display:flex;flex-direction:column;gap:10px;padding:14px 16px;border-top:1px solid var(--bt-line);background:color-mix(in srgb,var(--bt-main) 55%,var(--bt-card));animation:bt-veil-in .2s ease-out backwards}
.bt-ib-detail .bt-q,.bt-ib-detail .bt-q-inline,.bt-ib-detail .bt-q-inline .bt-q,.bt-ib-detail .bt-mw-card{margin:0;max-width:none;order:0}
.bt-ib-acts{display:flex;align-items:center;justify-content:flex-end;gap:6px}
.bt-ib-link{display:inline-flex;align-items:center;gap:3px;padding:4px 8px;border:0;border-radius:6px;background:transparent;color:var(--bt-ink-2);font:inherit;font-size:12px;line-height:16px;font-weight:500;cursor:pointer;transition:background-color .12s ease,color .12s ease}
.bt-ib-link:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bt-ib-reply-top{display:flex;align-items:center;gap:7px;min-width:0;font-size:14px;line-height:20px;font-weight:500;color:var(--bt-ink)}
.bt-ib-unread-dot{width:6px;height:6px;border-radius:50%;corner-shape:round;flex:none;background:var(--bt-accent)}
.bt-ib-preview{font-size:13px;line-height:18px;color:var(--bt-ink-2);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.bt-ib-go{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;color:var(--bt-ink-3);transition:translate ${SPRING_TAP.duration}ms ${SPRING_TAP.easing},color .12s ease}
.bt-ib-row:hover .bt-ib-go{translate:2px 0;color:var(--bt-ink-2)}
.bt-ib-empty{display:flex;flex-direction:column;align-items:center;gap:12px;margin-top:108px!important;text-align:center}
.bt-ib-empty-mark{width:48px;height:48px;border-radius:50%;corner-shape:round;display:inline-flex;align-items:center;justify-content:center;background:var(--bt-hover);color:var(--bt-ink-3)}
.bt-ib-empty-text{font-size:14px;line-height:20px;font-weight:500;color:var(--bt-ink-2)}
@media (prefers-reduced-motion:reduce){.bt-ib-pill,.bt-ib-chev,.bt-ib-go,.bt-ib-detail{animation:none;transition:none}}
`
