import { createElement as h, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { call } from '../../../ds-bot/src/client/api.js'
import { ChatRows, Shimmer } from '../../../ds-bot/src/client/cells.js'
import { ComposerPlus, ComposerVoice } from '../../../ds-bot/src/client/composer.js'
import { sendsOnEnter } from '../../../ds-bot/src/client/enter-key.js'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { ArrowUpIcon } from '../../../ds-bot/src/client/icons.js'
import { ModelChoiceDock } from '../../../ds-bot/src/client/model-menu.js'
import { PendingQuestion } from '../../../ds-bot/src/client/questions.js'
import { writingBlocks } from '../../../ds-bot/src/client/session-log.js'
import { currentPart } from '../../../ds-bot/src/client/text.js'
import { WidgetDock } from '../../../ds-bot/src/client/widget-cell.js'
import { SessionTranscript, useSessionFollow } from './session-chat.js'

// The chat follows its end while the user is this close to it.
const FOLLOW_PX = 80
const sameItem = (a, b) => (a.id !== undefined && b.id !== undefined
  ? a.id === b.id && a.kind === b.kind && (a.time ?? null) === (b.time ?? null)
  : a.kind === b.kind && a.time === b.time && a.text === b.text)

// `room-chat` speaks the mobile API contract (kind: 'bot' with botId/name/color,
// kind: 'event' with event: 'done'|'failed'|'schedule'|...). `ChatRows` expects
// group rows as 'post' and 'relay' so members stay distinct and round events render
// with RelayEvent instead of falling into the 1:1 'Message from a Bot' row.
export function adaptRoomItem(item) {
  if (!item || typeof item !== 'object') return item
  if (item.kind === 'bot') {
    return {
      id: item.id,
      kind: 'post',
      seq: item.id,
      botId: item.botId,
      name: item.name,
      color: item.color,
      text: item.text,
      time: item.time,
      ...(Number.isFinite(item.duration) ? { duration: item.duration } : {}),
      ...(item.whole?.file ? { file: item.whole.file, length: item.whole.length } : {}),
    }
  }
  if (item.kind === 'event') {
    return {
      id: item.id,
      kind: 'relay',
      time: item.time,
      reply: {
        kind: item.event,
        botId: item.botId,
        name: item.name,
        color: item.color,
        text: item.text,
        code: item.code,
        time: item.time,
      },
    }
  }
  return item
}

export const adaptRoomItems = items => (Array.isArray(items) ? items.map(adaptRoomItem) : [])

// Merges a refreshed newest page onto already-loaded history without discarding
// earlier pages or rewinding the cursor.
export function mergeLatestPage(currentItems, currentCursor, nextItems, nextCursor) {
  if (currentItems.length === 0) return { items: nextItems, cursor: nextCursor }
  if (nextItems.length === 0) return { items: [], cursor: nextCursor }
  let cut = -1
  for (const next of nextItems) {
    for (let i = currentItems.length - 1; i >= 0; i -= 1) {
      if (sameItem(currentItems[i], next)) { cut = i; break }
    }
    if (cut !== -1) break
  }
  if (cut > 0) return { items: [...currentItems.slice(0, cut), ...nextItems], cursor: currentCursor }
  if (cut === 0) return { items: nextItems, cursor: nextCursor }
  if (nextCursor && nextCursor.beforeSeq === undefined && Number.isInteger(nextCursor.part)) {
    return { items: [...currentItems, ...nextItems], cursor: currentCursor }
  }
  return { items: nextItems, cursor: nextCursor }
}

const userItemKey = item => (item.id !== undefined ? `id:${item.id}` : `t:${item.time ?? ''}:${item.text}`)

// Group chat: pages from `room-chat`, refreshed when the live feed announces room activity.
function useRoomChat(roomId, part, feed, keep, onUserMatch) {
  const active = roomId !== undefined
  const [view, setView] = useState({ sessionId: null, items: [], cursor: null, loading: active, failed: false })
  const ready = useRef(false)
  const busy = useRef(false)
  const reloadQueued = useRef(false)
  const gen = useRef(0)
  const hasLoaded = useRef(false)
  const knownUserIds = useRef(new Set())
  const onUserMatchRef = useRef(onUserMatch)
  onUserMatchRef.current = onUserMatch

  const load = useCallback(async (cursor, scroller, refresh = false) => {
    if (!active) return
    if (busy.current) {
      if (cursor === undefined) reloadQueued.current = true
      return
    }
    const myGen = gen.current
    busy.current = true
    if (cursor === undefined && !refresh) ready.current = false
    if (!refresh) setView(current => ({ ...current, loading: true, failed: false }))
    try {
      const page = await call('room-chat', { roomId, ...(cursor ? { cursor } : {}) })
      if (gen.current !== myGen) return
      const pageItems = adaptRoomItems(page.items)
      const pageSessionId = page.sessionId ?? part
      if (cursor === undefined) {
        ready.current = true
        setView((current) => {
          if (refresh && current.sessionId === pageSessionId && current.items.length > 0) {
            const merged = mergeLatestPage(current.items, current.cursor, pageItems, page.cursor)
            return { ...current, items: merged.items, cursor: merged.cursor, loading: false, failed: false }
          }
          return { sessionId: pageSessionId, items: pageItems, cursor: page.cursor, loading: false, failed: false }
        })
        const initial = !hasLoaded.current
        hasLoaded.current = true
        const freshUsers = []
        for (const item of pageItems) {
          if (item.kind !== 'user') continue
          const key = userItemKey(item)
          if (knownUserIds.current.has(key)) continue
          knownUserIds.current.add(key)
          freshUsers.push(item)
        }
        if (freshUsers.length > 0) onUserMatchRef.current?.(freshUsers, initial)
      } else {
        for (const item of pageItems) {
          if (item.kind === 'user') knownUserIds.current.add(userItemKey(item))
        }
        // Content added above the viewport would push the view down; keep its distance from the end.
        if (scroller) keep.current = scroller.scrollHeight - scroller.scrollTop
        setView(current => ({ ...current, items: [...pageItems, ...current.items], cursor: page.cursor, loading: false }))
      }
    } catch {
      if (gen.current !== myGen) return
      ready.current = cursor !== undefined || refresh || ready.current
      if (!refresh) setView(current => ({ ...current, loading: false, failed: true }))
    } finally {
      if (gen.current === myGen) {
        busy.current = false
        if (reloadQueued.current) {
          reloadQueued.current = false
          void loadRef.current(undefined, undefined, true)
        }
      }
    }
  }, [active, roomId, part, keep])
  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(() => {
    const myGen = ++gen.current
    busy.current = false
    reloadQueued.current = false
    ready.current = false
    hasLoaded.current = false
    knownUserIds.current.clear()
    setView({ sessionId: null, items: [], cursor: null, loading: active, failed: false })
    if (active) void loadRef.current(undefined)
    return () => {
      if (gen.current === myGen) gen.current += 1
      busy.current = false
      reloadQueued.current = false
    }
  }, [active, roomId, part])

  useEffect(() => {
    if (!active || !feed) return undefined
    return feed.on((event, data) => {
      if (event === 'hello') { if (ready.current) void loadRef.current(undefined, undefined, true); return }
      if (event === 'room' && data?.roomId === roomId) void loadRef.current(undefined, undefined, true)
    })
  }, [active, feed, roomId])

  return { view, load }
}

// What the Bot views' voice button asks of a composer (DSH's composer in the plugin):
// where the caret is, and text put in there.
function useInput(field, setText) {
  return useMemo(() => ({
    captureInsertion: () => (field.current ? { start: field.current.selectionStart, end: field.current.selectionEnd } : null),
    insertText: (value, at) => setText((current) => {
      const start = Math.min(at?.start ?? current.length, current.length)
      return current.slice(0, start) + value + current.slice(Math.max(start, at?.end ?? start))
    }),
  }), [field, setText])
}

function Composer({ sessionId, placeholder, disabled, onSend, actions, useUi, useRoster }) {
  const [text, setText] = useState('')
  const [error, setError] = useState(null)
  const field = useRef(null)
  const inputActions = useInput(field, setText)
  const enterToSend = useRoster(state => sendsOnEnter(state.prefs))
  useLayoutEffect(() => {
    const node = field.current
    node.style.height = 'auto'
    node.style.height = `${node.scrollHeight}px`
  }, [text])
  useEffect(() => { if (!disabled) field.current?.focus() }, [sessionId, disabled])
  const submit = async () => {
    const value = text.trim()
    if (value === '' || disabled) return
    setError(null)
    setText('')
    try {
      await onSend(value)
    } catch (failure) {
      setText(current => (current === '' ? value : current))
      setError(failure.message)
    }
  }
  return h('div', { className: 'dsb-composer-wrap' },
    error ? h('p', { className: 'dsb-composer-error', role: 'alert' }, error) : null,
    h('div', { className: 'dsb-composer', 'data-composer-card': '', 'data-multiline': text.includes('\n') || undefined },
      h('div', { className: 'dsb-composer-tools' }, h(ComposerPlus, { sessionId, inputActions, useRoster, actions })),
      h('div', { className: 'dsb-composer-input', 'data-input-scroll': '' },
        h('textarea', {
          ref: field,
          rows: 1,
          value: text,
          disabled,
          placeholder,
          'aria-label': placeholder,
          'data-composer-input': '',
          onChange: event => setText(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter' && enterToSend && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
              event.preventDefault()
              void submit()
            }
          },
        })),
      h('div', { className: 'dsb-composer-trailing' },
        h(ComposerVoice, { sessionId, inputActions, actions, useUi, useRoster }),
        h('button', { type: 'button', className: 'dsb-send', disabled: disabled || text.trim() === '', 'aria-label': t('Send message'), title: t('Send message'), onClick: () => { void submit() } }, h(ArrowUpIcon)))))
}

// One conversation in the main view, drawn with the Bot views' own rows, cards and docks.
// DM current segments follow DSH's session log via `api/bot/session` + `session-log.js`;
// group chats continue to read `room-chat`.
export function Chat({ sessionId, team, registry }) {
  const { actions, hooks, chat: feed } = team
  const roster = hooks.useRoster(value => value)
  const bot = roster.byId[sessionId]
  const room = roster.roomsById[sessionId]
  const isRoom = room !== undefined
  // Always follow the Bot's current segment (parts may roll over mid-conversation).
  const activeSessionId = isRoom ? sessionId : (bot ? currentPart(bot) : sessionId)
  const name = bot?.name ?? room?.name ?? ''

  const [pending, setPending] = useState([])
  const sendGen = useRef(0)
  const scroller = useRef(null)
  const follow = useRef(true)
  const keep = useRef(null)

  useEffect(() => {
    sendGen.current += 1
    keep.current = null
    follow.current = true
    setPending([])
  }, [activeSessionId])

  const clearPendingUsers = useCallback((freshUsers, initial) => {
    setPending((list) => {
      if (list.length === 0) return list
      const next = list.slice()
      for (const item of freshUsers) {
        const at = next.findIndex(entry => entry.text === item.text
          && (!initial || !Number.isFinite(item.time) || item.time >= entry.time - 2000))
        if (at >= 0) next.splice(at, 1)
      }
      return next.length === list.length ? list : next
    })
  }, [])

  const onSessionUser = useCallback((text, time, initial) => {
    clearPendingUsers([{ text, time }], initial)
  }, [clearPendingUsers])

  const roomChat = useRoomChat(room?.id, sessionId, feed, keep, clearPendingUsers)
  const dmChat = useSessionFollow({
    sessionId: activeSessionId,
    enabled: !isRoom && Boolean(activeSessionId),
    feed,
    readOnly: Boolean(roster.readOnly),
    onUserMessage: onSessionUser,
    keep,
  })

  // While a DM reply streams text through `api/bot/session`, mark it live so the activity row yields.
  const dmWritingText = !isRoom && writingBlocks(dmChat.log).some(block => block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '')
  useEffect(() => {
    if (isRoom || !activeSessionId || typeof actions.noteLive !== 'function') return undefined
    actions.noteLive(activeSessionId, 'session-reply', dmWritingText ? { text: true } : null)
    return () => actions.noteLive(activeSessionId, 'session-reply', null)
  }, [isRoom, activeSessionId, dmWritingText, actions])

  useEffect(() => {
    document.body?.toggleAttribute?.('data-bt-room', isRoom)
    return () => { document.body?.removeAttribute?.('data-bt-room') }
  }, [isRoom])

  const question = roster.questions?.[activeSessionId] ?? roster.questions?.[sessionId]
  const running = hooks.useSessionStatus(map => map.get(activeSessionId)?.running === true)

  const contentRevision = isRoom ? roomChat.view.items : dmChat.log.revision
  useLayoutEffect(() => {
    const node = scroller.current
    if (!node) return
    if (keep.current !== null) {
      node.scrollTop = node.scrollHeight - keep.current
      keep.current = null
    } else if (follow.current) node.scrollTop = node.scrollHeight
  }, [contentRevision, pending, running, question])

  const onScroll = () => {
    const node = scroller.current
    if (!node) return
    follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < FOLLOW_PX
  }

  // Shown at once: the message can arrive on the follow/feed before the request returns.
  const send = async (text) => {
    const myGen = sendGen.current
    const entry = { kind: 'user', text, time: Date.now() }
    setPending(list => [...list, entry])
    actions.noteSent(activeSessionId)
    try {
      await actions.send(activeSessionId, text)
    } catch (error) {
      if (sendGen.current === myGen) setPending(list => list.filter(item => item !== entry))
      throw error
    }
  }

  const busy = isRoom ? roomChat.view.loading : (dmChat.loading || dmChat.paging)
  const earlier = isRoom
    ? (roomChat.view.loading && roomChat.view.sessionId !== null ? h(Shimmer, null, t('Loading earlier messages…'))
      : roomChat.view.failed ? h('button', { type: 'button', className: 'bt-soft', onClick: () => roomChat.load(roomChat.view.cursor ?? undefined, scroller.current) }, t('Couldn’t load earlier messages · Retry'))
        : roomChat.view.cursor ? h('button', { type: 'button', className: 'bt-soft', onClick: () => roomChat.load(roomChat.view.cursor, scroller.current) }, t('Load earlier')) : null)
    : (dmChat.paging ? h(Shimmer, null, t('Loading earlier messages…'))
      : dmChat.pageFailed ? h('button', { type: 'button', className: 'bt-soft', onClick: () => dmChat.loadEarlier(scroller.current) }, t('Couldn’t load earlier messages · Retry'))
        : dmChat.hasMore ? h('button', { type: 'button', className: 'bt-soft', onClick: () => dmChat.loadEarlier(scroller.current) }, t('Load earlier')) : null)

  const sessionNotice = !isRoom && (dmChat.terminalError || dmChat.failed)
    ? h('div', { className: 'dsb-session-error', role: 'alert' },
      h('span', null, dmChat.terminalError ? t('Session unavailable') : t('Couldn’t load this conversation')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: dmChat.retry }, t('Retry')))
    : null

  const waiting = bot?.waiting === true

  return h('div', { className: 'dsb-chat' },
    h('div', { ref: scroller, className: 'dsb-scroll', 'data-conversation-scroll': '', onScroll },
      h('div', { className: 'dsb-column' },
        earlier ? h('div', { className: 'bt-earlier-top' }, earlier) : null,
        sessionNotice,
        h('div', { className: 'dsb-flow', 'data-chat-flow': '', role: 'feed', 'aria-label': name, 'aria-busy': busy },
          isRoom
            ? h(ChatRows, { items: roomChat.view.items, sessionId, roster, actions, useUi: hooks.useUi, clock: true })
            : h(SessionTranscript, { log: dmChat.log, sessionId: activeSessionId, bot, roster, actions, useUi: hooks.useUi, useRoster: hooks.useRoster, useTurnClock: hooks.useTurnClock, useHeldCards: hooks.useHeldCards, thinkingAt: dmChat.thinkingAt, hasMore: dmChat.hasMore, registry }),
          pending.length ? h('div', { className: 'dsb-pending' }, h(ChatRows, { items: pending, sessionId: activeSessionId, roster, actions })) : null,
          // The Bot views' activity row (from the header pill) draws itself in here.
          h('div', { 'data-chat-running': '' }),
          question ? h(PendingQuestion, { key: JSON.stringify([activeSessionId, question.id]), sessionId: activeSessionId, question, actions, inline: true, enterToSend: sendsOnEnter(roster.prefs) }) : null))),
    h('div', { className: 'dsb-composer-root' },
      !isRoom ? h(WidgetDock, { sessionId: activeSessionId, useRoster: hooks.useRoster, useCards: hooks.useCards, useHeldCards: hooks.useHeldCards, actions }) : null,
      h(ModelChoiceDock, { sessionId: activeSessionId, useRoster: hooks.useRoster, actions }),
      h(Composer, {
        sessionId: activeSessionId,
        disabled: waiting,
        placeholder: waiting ? t('Pick a model and {name} can start.', { name }) : name ? t('Message {name}', { name }) : t('Message'),
        onSend: send,
        actions,
        useUi: hooks.useUi,
        useRoster: hooks.useRoster,
      })))
}
