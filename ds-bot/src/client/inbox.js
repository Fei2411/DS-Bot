// The inbox: one place for everything across Bots and group chats that waits on the
// user. The host derives the list (src/host/inbox.js) and every surface reads it: the
// sidebar trigger beside New…, this page, the sidebar's marks and the notifications.
// Each waiting item renders directly as one flat, actionable card in a single column
// so the user can triage top-to-bottom without opening a second view or nesting boxes.
import { createElement as h, useEffect, useRef, useState } from 'react'
import { useOptionKeys } from 'deep-view/react'
import { BotAvatar, RoomAvatar } from './mark.js'
import { Segmented } from './motion.js'
import { useEscape } from './overlay-hooks.js'
import { CheckIcon, ChevronRightIcon, CloseIcon } from './icons.js'
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
import { sendsOnEnter } from './enter-key.js'
import { currentPart, previewOf } from './text.js'
import { t } from './i18n.js'
import { INBOX_SECTIONS, inboxSummary, inboxTag } from './inbox-text.js'

const NONE = Object.freeze([])
const useNothing = () => undefined
const noop = () => {}

// While the inbox covers the chat and stacks multiple items in one view, bare
// document-wide option letters (A/B/C) would be ambiguous across cards or could
// answer a covered chat behind the inbox. Holding two leases on the shared
// useOptionKeys registry keeps its count >= 2 so neither hints nor listeners fire
// (without calling preventDefault on letter keys) until the inbox unmounts.
function OptionKeyGuard() {
  const emptyRef = useRef(null)
  useOptionKeys(1, noop, emptyRef)
  useOptionKeys(1, noop, emptyRef)
  return null
}

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

// Resolve whether this item renders its own actionable card/step here (as opposed to
// falling back to the single Open-in-chat prompt), so the header never duplicates it.
function hasOwnAction(item, bot, roster, hooks) {
  switch (item.kind) {
    case 'approval': return Boolean(bot && hooks.approvals.some(entry => entry.id === item.ref))
    case 'computer': return Boolean(bot && hooks.asks[item.ref])
    case 'question': return Boolean(roster.questions?.[item.sessionId])
    case 'view': return Boolean(roster.views?.[item.sessionId])
    case 'secret': return Boolean(bot && (roster.secretRequests?.[item.botId] ?? []).some(entry => entry.id === item.ref))
    case 'connector': return Boolean(bot && (roster.connectorRequests?.[item.botId] ?? []).some(entry => entry.id === item.ref))
    case 'mail': return Boolean(bot && (roster.mailRequests?.[item.botId] ?? []).some(entry => entry.id === item.ref))
    case 'handoff': return Boolean(bot && (item.surface === 'computer' ? hooks.computerHolds[item.botId] : hooks.browserHolds[item.botId]))
    case 'paused': return hooks.paused.some(entry => entry.id === item.ref)
    case 'room-paused':
    case 'blocked': return true
    case 'learning': return (roster.learning?.[item.botId] ?? []).some(entry => entry.id === item.ref)
    default: return false
  }
}

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

function ItemAvatar({ item, bot, room, roster, size = 20 }) {
  if (bot && !(item.kind === 'room-paused' || item.kind === 'goal')) {
    return h(BotAvatar, { bot, size, badge: false, live: false })
  }
  if (room) return h(RoomAvatar, { room, roster, size })
  return h('span', { className: 'bt-ib-noface', style: { width: size, height: size } })
}

// The chat's own card rendered flat inside the single item surface (zero nested chrome).
function ItemBody({ item, bot, summary, roster, actions, hooks }) {
  const [busy, setBusy] = useState(false)
  const inFlightRef = useRef(null)
  const run = (make) => {
    if (inFlightRef.current) return inFlightRef.current
    setBusy(true)
    const pending = Promise.resolve().then(make)
      .catch(error => actions.reportError?.(error, 'inbox'))
      .finally(() => { inFlightRef.current = null; setBusy(false) })
    inFlightRef.current = pending
    return pending
  }
  const open = () => openItem(item, actions)
  const compact = (label, onClick, disabled = false) => h('div', { className: 'bt-ib-compact' },
    h('span', { className: 'bt-ib-compact-text' }, summary),
    h('button', { type: 'button', className: 'bt-send bt-ib-btn', disabled, onClick }, t(label)))
  // Guard synchronous double-clicks on approval buttons (returning the in-flight promise
  // so ApprovalCard keeps its disabled state until settled) and ensure browser/computer
  // takeover dismisses the inbox pane (z 44) before revealing the right panel (z 40).
  const guardedActions = {
    ...actions,
    answerApproval: (id, choice) => run(() => actions.answerApproval(id, choice)),
    computerAppAnswer: (id, choice) => run(() => actions.computerAppAnswer(id, choice)),
    ...(bot ? {
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
    } : {}),
  }
  switch (item.kind) {
    case 'approval': {
      const approval = hooks.approvals.find(entry => entry.id === item.ref)
      return approval && bot
        ? h(ApprovalCard, { approval, bot, actions: guardedActions })
        : compact('Open in chat', open)
    }
    case 'computer': {
      const ask = hooks.asks[item.ref]
      return ask && bot
        ? h(ComputerAppApprovalCard, { ask, bot, actions: guardedActions })
        : compact('Open in chat', open)
    }
    case 'question': {
      const question = roster.questions?.[item.sessionId]
      return question ? h(PendingQuestion, { sessionId: item.sessionId, question, actions, inline: true, enterToSend: sendsOnEnter(roster.prefs) }) : compact('Open in chat', open)
    }
    case 'view': {
      const view = roster.views?.[item.sessionId]
      return view ? h(PendingView, { sessionId: item.sessionId, view, actions, inline: true }) : compact('Open in chat', open)
    }
    case 'secret': {
      const request = (roster.secretRequests?.[item.botId] ?? []).find(entry => entry.id === item.ref)
      return request && bot ? h(SecretCard, { sessionId: request.sessionId ?? currentPart(bot), bot, request, roster, actions, inline: true }) : compact('Open in chat', open)
    }
    case 'connector': {
      const request = (roster.connectorRequests?.[item.botId] ?? []).find(entry => entry.id === item.ref)
      return request && bot ? h(ConnectorCard, { sessionId: request.sessionId ?? currentPart(bot), bot, request, roster, actions, inline: true }) : compact('Open in chat', open)
    }
    case 'mail': {
      const request = (roster.mailRequests?.[item.botId] ?? []).find(entry => entry.id === item.ref)
      return request && bot ? h(MailSendCard, { sessionId: request.sessionId ?? currentPart(bot), bot, request, roster, actions, inline: true }) : compact('Open in chat', open)
    }
    case 'handoff': {
      if (!bot) return compact('Open in chat', open)
      if (item.surface === 'computer') {
        const hold = hooks.computerHolds[item.botId]
        return hold ? h(PendingComputerHandoff, { sessionId: item.sessionId ?? currentPart(bot), bot, hold, actions: guardedActions, inline: true }) : compact('Open in chat', open)
      }
      const hold = hooks.browserHolds[item.botId]
      return hold ? h(PendingHandoff, { sessionId: item.sessionId ?? currentPart(bot), bot, hold, hooks: hooks.browser, actions: guardedActions, inline: true }) : compact('Open in chat', open)
    }
    case 'paused': {
      const work = hooks.paused.find(entry => entry.id === item.ref)
      return work ? h(WorkPauseCard, { work, roster, actions, inline: true }) : compact('Open in chat', open)
    }
    case 'room-paused':
      return compact('Continue', () => void run(() => actions.resumeRoomPause(item.roomId)), busy)
    // The chat's own failure card holds every fix (a key, a sign-in, another model).
    case 'blocked':
      return compact('Retry', () => void run(() => actions.resume(item.botId)), busy)
    case 'learning': {
      const proposal = (roster.learning?.[item.botId] ?? []).find(entry => entry.id === item.ref)
      return proposal ? h(ProposalCard, { proposal, actions, onFailure: () => {}, onResolved: () => {} }) : compact('Open in chat', open)
    }
    default:
      return compact('Open in chat', open)
  }
}

function TriageCard({ item, gone, roster, actions, hooks, itemRef }) {
  const bot = item.botId === undefined ? undefined : roster.byId?.[item.botId]
  const room = item.roomId === undefined ? undefined : roster.roomsById?.[item.roomId]
  const who = [bot?.name, room?.name].filter(Boolean).join(' · ')
  const summary = inboxSummary(item, t, id => roster.byId?.[id]?.name)
  const showOpenLink = !gone && hasOwnAction(item, bot, roster, hooks)
  return h('article', {
    ref: itemRef,
    tabIndex: gone ? undefined : -1,
    className: 'bt-ib-row',
    'data-item-id': item.id,
    'data-gone': gone || undefined,
  },
  h('div', { className: 'bt-ib-bar' },
    h('span', { className: 'bt-ib-who' },
      h(ItemAvatar, { item, bot, room, roster, size: 20 }),
      who ? h('span', { className: 'bt-ib-name' }, who) : null,
      who ? h('span', { className: 'bt-ib-sep', 'aria-hidden': true }, '·') : null,
      h('span', { className: 'bt-ib-kind', 'data-group': item.group }, t(inboxTag(item))),
      !gone && item.at > 0 ? h('span', { className: 'bt-ib-sep', 'aria-hidden': true }, '·') : null,
      !gone && item.at > 0 ? h(Elapsed, { at: item.at, className: 'bt-ib-time', dot: false }) : null),
    gone
      ? h('span', { className: 'bt-ib-ok' }, h(CheckIcon), t('Handled'))
      : showOpenLink
        ? h('button', { type: 'button', className: 'bt-ib-link', onClick: () => openItem(item, actions) },
            t('Open in chat'), h(ChevronRightIcon))
        : null),
  gone
    ? h('div', { className: 'bt-ib-gone-summary' }, summary || who)
    : h('div', { className: 'bt-ib-detail' },
        h(ItemBody, { item, bot, summary, roster, actions, hooks })))
}

// An answered item shows a quiet Handled strip for a brief grace period before leaving
// so the next item does not jump away under the pointer.
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
 * The inbox page over the conversation column. Waiting for you: a single-column batch
 * triage list where every item is directly actionable with one click and zero nested
 * boxes. New replies: unread conversations; clicking opens the chat.
 */
export function InboxPane({ paneLeft, roster, actions, useSessions, useWork, useComputer, useSessionStatus, useBotCompletions, useBrowserHolds, useBrowserTabs, useBrowserPages }) {
  const [tab, setTab] = useState('wait')
  const [who, setWho] = useState('all')
  const paneRef = useRef(null)
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
  useEscape(() => actions.closeInbox?.())

  // Conversations with replies not read yet: a Bot's own chat, or a group chat. A Bot's
  // chat reads the window's completions (bot-completions.js leaves out exchanges the user
  // does not see) where it has them, else the Session's own status.
  const completedBots = (useBotCompletions ?? useNothing)(map => Object.keys(map ?? {}).filter(id => map[id] === true).sort().join('|'))
  const statusBots = (useSessionStatus ?? useNothing)(map => (roster.bots ?? []).map(bot => currentPart(bot)).filter(id => map?.get?.(id)?.completionUnread === true).join('|'))
  const botUnread = (useBotCompletions ? completedBots : statusBots) ?? ''
  const roomUnread = (useSessionStatus ?? useNothing)(map => (roster.rooms ?? []).filter(room => map?.get?.(room.sessionId ?? room.id)?.completionUnread === true).map(room => room.id).join('|')) ?? ''
  const unreadParts = new Set(botUnread.split('|').filter(Boolean))
  const unreadRoomIds = roomUnread.split('|').filter(Boolean)
  const roomMetaKey = (useSessions ?? useNothing)(list => unreadRoomIds.map((id) => {
    const room = roster.roomsById?.[id]
    if (!room) return ''
    const part = room.sessionId ?? room.id
    return `${id}\u0000${list?.byId?.[part]?.updatedAt ?? 0}\u0000${previewOf(list, part)}`
  }).join('\u0001')) ?? ''
  const roomMeta = new Map(roomMetaKey ? roomMetaKey.split('\u0001').filter(Boolean).map((entry) => {
    const [id, at, preview] = entry.split('\u0000')
    return [id, { at: Number(at) || 0, preview: preview ?? '' }]
  }) : [])
  const replies = [
    ...(roster.bots ?? []).filter(bot => unreadParts.has(currentPart(bot))).map(bot => ({ id: bot.id, bot, at: bot.lastAt ?? 0, preview: bot.preview })),
    ...unreadRoomIds.map(id => roster.roomsById?.[id]).filter(Boolean).map((room) => {
      const meta = roomMeta.get(room.id)
      return { id: room.id, room, at: room.lastAt || meta?.at || 0, preview: room.preview || meta?.preview || '' }
    }),
  ].sort((a, b) => b.at - a.at)

  const sections = INBOX_SECTIONS.map(([group, title]) => {
    const rows = shown.filter(item => item.group === group).sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
    return { group, title, rows }
  }).filter(section => section.rows.length > 0)

  // ↑ ↓ step focus across cards or replies without stealing keys handled by inner
  // widgets (charts, menus, sliders, radiogroups, form inputs).
  const onKey = (event) => {
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key]
    if (step === undefined || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
    if (typeof Element !== 'undefined' && event.target instanceof Element
      && event.target.closest('input,textarea,select,[contenteditable=true],[role=menu],[role=listbox],[role=slider],[role=radiogroup]')) return
    const ids = tab === 'wait'
      ? sections.flatMap(section => section.rows).filter(item => !gone.has(item.id)).map(item => item.id)
      : replies.map(entry => `reply:${entry.id}`)
    if (ids.length === 0) return
    event.preventDefault()
    const active = typeof document !== 'undefined' ? document.activeElement : null
    const at = ids.findIndex((id) => {
      const node = refs.current.get(id)
      return node === active || Boolean(active && node?.contains?.(active))
    })
    const next = ids[at === -1 ? 0 : Math.max(0, Math.min(ids.length - 1, at + step))]
    const target = refs.current.get(next)
    target?.focus?.({ preventScroll: false })
    target?.scrollIntoView?.({ block: 'nearest' })
  }

  const count = items.length

  return h('div', { className: 'bt-pane bt-ib-pane', style: { left: paneLeft } },
    h(OptionKeyGuard),
    h('div', { ref: paneRef, tabIndex: -1, className: 'bt-ib-page', role: 'region', 'aria-label': t('Inbox'), onKeyDown: onKey },
      h('header', { className: 'bt-ib-top', 'data-window-drag': true },
        h('div', { className: 'bt-ib-top-in' },
          h('div', { className: 'bt-ib-head-row' },
            h('div', { className: 'bt-ib-head-left' },
              h('h1', null, t('Inbox')),
              h(Segmented, { label: t('Inbox'), value: tab, className: 'bt-ib-seg' },
                h('button', { type: 'button', 'aria-pressed': tab === 'wait', onClick: () => setTab('wait') },
                  t('Waiting for you'), count > 0 ? h('span', { className: 'bt-ib-tab-n' }, String(count)) : null),
                h('button', { type: 'button', 'aria-pressed': tab === 'replies', onClick: () => setTab('replies') },
                  t('New replies'), replies.length > 0 ? h('span', { className: 'bt-ib-tab-n' }, String(replies.length)) : null))),
            h('button', { type: 'button', className: 'bt-icon-btn bt-ib-close', 'aria-label': t('Close'), title: t('Close'), onClick: () => actions.closeInbox?.() }, h(CloseIcon))),
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
            : null)),
      h('div', { className: 'bt-ib-scroll' },
        tab === 'wait'
          ? (shown.length === 0
              ? h(Empty, { text: t('Nothing waits for you') })
              : sections.map(({ group, title, rows }) => {
                  const left = rows.filter(item => !gone.has(item.id)).length
                  return h('section', { key: group, className: 'bt-ib-sec' },
                    h('h3', null,
                      h('span', { className: 'bt-ib-dot', 'data-group': group, 'aria-hidden': true }),
                      t(title),
                      left > 0 ? h('span', { className: 'bt-ib-sec-n' }, String(left)) : null),
                    h('div', { className: 'bt-ib-list' }, rows.map(item => h(TriageCard, {
                      key: item.id, item, gone: gone.has(item.id), roster, actions, hooks,
                      itemRef: (node) => { if (node) refs.current.set(item.id, node); else refs.current.delete(item.id) },
                    }))))
                }))
          : (replies.length === 0
              ? h(Empty, { text: t('No new replies') })
              : h('div', { className: 'bt-ib-replies' }, replies.map(entry => h('button', {
                  key: entry.id,
                  ref: (node) => { const key = `reply:${entry.id}`; if (node) refs.current.set(key, node); else refs.current.delete(key) },
                  type: 'button',
                  className: 'bt-ib-row bt-ib-reply-row',
                  'data-item-id': `reply:${entry.id}`,
                  onClick: () => { actions.openSession(entry.id); actions.closeInbox?.() },
                },
                entry.bot ? h(BotAvatar, { bot: entry.bot, size: 36, badge: false, live: false }) : h(RoomAvatar, { room: entry.room, roster, size: 36 }),
                h('span', { className: 'bt-ib-copy' },
                  h('span', { className: 'bt-ib-reply-head' },
                    h('span', { className: 'bt-ib-reply-top' },
                      h('span', { className: 'bt-ib-unread-dot', 'aria-hidden': true }),
                      h('span', { className: 'bt-ib-name' }, (entry.bot ?? entry.room).name)),
                    entry.at > 0 ? h(Elapsed, { at: entry.at, className: 'bt-ib-time', dot: false }) : null),
                  entry.preview ? h('span', { className: 'bt-ib-preview' }, entry.preview) : null),
                h('span', { className: 'bt-ib-go', 'aria-hidden': true }, h(ChevronRightIcon)))))))))
}

export const INBOX_CSS = `
.bt-ib-trigger{position:relative}
.bt-ib-trigger[data-has]{color:var(--bt-ink)}
.bt-side-top .bt-ib-trigger[aria-current=page],.bt-leftcol-foot-rail .bt-ib-trigger[aria-current=page]{background:var(--bt-active);color:var(--bt-ink)}
.bt-ib-badge{position:absolute;top:-1px;right:-2px;min-width:15px;height:15px;padding:0 4px;box-sizing:border-box;border-radius:999px;corner-shape:round;background:var(--bt-accent);color:var(--bt-accent-ink);font-size:10px;line-height:15px;font-weight:600;text-align:center;font-variant-numeric:tabular-nums;box-shadow:0 0 0 1.5px var(--bt-sidebar);pointer-events:none}
.bt-ib-trigger[data-rail] .bt-ib-badge{top:-3px;right:-3px;min-width:16px;height:16px;line-height:16px}
.bt-ib-pane{z-index:44}
.bt-ib-page{flex:1;min-width:0;display:flex;flex-direction:column;background:var(--bt-main);color:var(--bt-ink);font-family:var(--bt-font)}
.bt-ib-page:focus{outline:none}
.bt-ib-top{flex:none;padding:14px 28px 12px;border-bottom:1px solid var(--bt-line);box-sizing:border-box}
.bt-ib-top-in{display:flex;flex-direction:column;gap:10px;max-width:680px;margin:0 auto}
.bt-ib-head-row{display:flex;align-items:center;justify-content:space-between;gap:12px}
.bt-ib-head-left{display:flex;align-items:center;gap:16px;min-width:0;flex-wrap:wrap}
.bt-ib-top h1{margin:0;font-size:18px;line-height:24px;font-weight:600;letter-spacing:-.015em;white-space:nowrap}
.bt-ib-close{flex:none;color:var(--bt-ink-2)}
.bt-ib-seg{flex:none}
.bt-ib-seg button{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 12px;font-size:13px;white-space:nowrap}
.bt-ib-tab-n{font-size:11px;line-height:16px;font-weight:600;color:var(--bt-ink-3);font-variant-numeric:tabular-nums}
.bt-ib-seg button[aria-pressed=true] .bt-ib-tab-n{color:var(--bt-ink-2)}
.bt-ib-pills{display:flex;align-items:center;gap:4px;flex-wrap:wrap;min-width:0}
.bt-ib-pill{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 9px;border:0;border-radius:999px;background:transparent;color:var(--bt-ink-2);font:inherit;font-size:12px;line-height:16px;font-weight:500;cursor:pointer;white-space:nowrap;transition:background-color .12s ease,color .12s ease}
.bt-ib-pill:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bt-ib-pill[aria-pressed=true]{background:var(--bt-active);color:var(--bt-ink)}
.bt-ib-pill:focus-visible,.bt-ib-row:focus-visible,.bt-ib-link:focus-visible{outline:2px solid var(--bt-accent);outline-offset:1px}
.bt-ib-scroll{flex:1;min-height:0;overflow-y:auto;padding:20px 28px 40px;display:flex;flex-direction:column;gap:24px;box-sizing:border-box}
.bt-ib-scroll>*{width:100%;max-width:680px;margin:0 auto;box-sizing:border-box}
.bt-ib-sec{display:flex;flex-direction:column;gap:10px}
.bt-ib-sec h3{display:flex;align-items:center;gap:7px;margin:0;padding:0 2px;font-size:12px;line-height:16px;font-weight:600;color:var(--bt-ink-2)}
.bt-ib-dot{width:6px;height:6px;border-radius:50%;corner-shape:round;flex:none;background:var(--bt-ink-3)}
.bt-ib-dot[data-group=decide]{background:var(--bt-star)}
.bt-ib-dot[data-group=fix]{background:var(--bt-danger)}
.bt-ib-dot[data-group=suggest]{background:var(--bt-accent)}
.bt-ib-sec-n{color:var(--bt-ink-3);font-weight:500;font-variant-numeric:tabular-nums}
.bt-ib-list{display:flex;flex-direction:column;gap:10px}
.bt-ib-row{border-radius:12px;background:var(--bt-card);border:1px solid var(--bt-line);box-sizing:border-box;transition:border-color .12s ease,opacity .16s ease}
.bt-ib-row:hover:not([data-gone]){border-color:var(--bt-line-2)}
.bt-ib-row[data-gone]{opacity:.52}
.bt-ib-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:38px;padding:7px 12px 7px 14px;border-bottom:1px solid var(--bt-line);box-sizing:border-box}
.bt-ib-who{display:flex;align-items:center;gap:6px;min-width:0;font-size:12px;line-height:16px;color:var(--bt-ink-2)}
.bt-ib-noface{flex:none}
.bt-ib-name{min-width:0;font-size:13px;line-height:18px;font-weight:500;color:var(--bt-ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-ib-sep{flex:none;color:var(--bt-ink-3)}
.bt-ib-kind{flex:none;font-weight:500;color:var(--bt-ink-2)}
.bt-ib-kind[data-group=decide]{color:var(--bt-warn)}
.bt-ib-kind[data-group=fix]{color:var(--bt-danger)}
.bt-ib-kind[data-group=suggest]{color:var(--bt-accent)}
.bt-ib-time{flex:none;font-size:11px;line-height:16px;color:var(--bt-ink-3);font-variant-numeric:tabular-nums;white-space:nowrap}
.bt-ib-ok{flex:none;display:inline-flex;align-items:center;gap:4px;font-size:12px;line-height:16px;color:var(--bt-green);font-weight:500;white-space:nowrap}
.bt-ib-ok svg{width:14px;height:14px}
.bt-ib-link{flex:none;display:inline-flex;align-items:center;gap:2px;height:24px;padding:0 6px;border:0;border-radius:6px;background:transparent;color:var(--bt-ink-2);font:inherit;font-size:12px;line-height:16px;font-weight:500;cursor:pointer;white-space:nowrap;transition:background-color .12s ease,color .12s ease}
.bt-ib-link:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bt-ib-detail{padding:14px 16px}
.bt-ib-page .bt-ib-detail .bt-q-inline,.bt-ib-page .bt-ib-detail .bt-q-inline:has(>.dv-view-bare){margin:0;max-width:none;width:100%;order:0}
.bt-ib-page .bt-ib-detail .bt-q,.bt-ib-page .bt-ib-detail .bt-q-inline .bt-q,.bt-ib-page .bt-ib-detail .bt-mw-card,.bt-ib-page .bt-ib-detail .bt-q-inline .dv-view,.bt-ib-page .bt-ib-detail .bt-q-inline .dv-q,.bt-ib-page .bt-ib-detail .dv-view,.bt-ib-page .bt-ib-detail .dv-q{margin:0;max-width:none;width:100%;order:0;padding:0;border:0;border-radius:0;background:none;box-shadow:none;animation:none}
.bt-ib-page .bt-ib-detail .bt-q-submit,.bt-ib-page .bt-ib-detail .dv-q-submit{animation:none}
.bt-ib-compact{display:flex;align-items:center;justify-content:space-between;gap:12px}
.bt-ib-compact-text{min-width:0;font-size:14px;line-height:20px;font-weight:500;color:var(--bt-ink)}
.bt-ib-btn{flex:none;height:30px;padding:0 14px;font-size:13px;font-weight:500}
.bt-ib-gone-summary{padding:10px 16px 12px;font-size:13px;line-height:18px;color:var(--bt-ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-ib-replies{display:flex;flex-direction:column;gap:4px}
.bt-ib-reply-row{width:100%;display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:10px;background:transparent;border:0;color:inherit;font:inherit;text-align:left;cursor:pointer;transition:background-color .12s ease}
.bt-ib-reply-row:hover{background:var(--bt-hover)}
.bt-ib-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.bt-ib-reply-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;min-width:0}
.bt-ib-reply-top{display:inline-flex;align-items:center;gap:7px;min-width:0;font-size:14px;line-height:20px;font-weight:500;color:var(--bt-ink)}
.bt-ib-unread-dot{width:6px;height:6px;border-radius:50%;corner-shape:round;flex:none;background:var(--bt-accent)}
.bt-ib-preview{font-size:13px;line-height:18px;color:var(--bt-ink-2);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.bt-ib-go{flex:none;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;color:var(--bt-ink-3);transition:color .12s ease}
.bt-ib-reply-row:hover .bt-ib-go{color:var(--bt-ink-2)}
.bt-ib-empty{display:flex;flex-direction:column;align-items:center;gap:12px;margin-top:108px!important;text-align:center}
.bt-ib-empty-mark{width:48px;height:48px;border-radius:50%;corner-shape:round;display:inline-flex;align-items:center;justify-content:center;background:var(--bt-hover);color:var(--bt-ink-3)}
.bt-ib-empty-text{font-size:14px;line-height:20px;font-weight:500;color:var(--bt-ink-2)}
@media (prefers-reduced-motion:reduce){.bt-ib-pill,.bt-ib-row,.bt-ib-reply-row,.bt-ib-link,.bt-ib-go{transition:none}}
`
