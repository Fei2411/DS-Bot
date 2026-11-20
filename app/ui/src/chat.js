import { createElement as h, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { call } from '../../../ds-bot/src/client/api.js'
import { Bubbles, ChatRows, Shimmer } from '../../../ds-bot/src/client/cells.js'
import { ComposerPlus, ComposerVoice } from '../../../ds-bot/src/client/composer.js'
import { sendsOnEnter } from '../../../ds-bot/src/client/enter-key.js'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { ArrowUpIcon } from '../../../ds-bot/src/client/icons.js'
import { ModelChoiceDock } from '../../../ds-bot/src/client/model-menu.js'
import { PendingQuestion } from '../../../ds-bot/src/client/questions.js'
import { ReadOnlyDock } from '../../../ds-bot/src/client/read-only-dock.js'

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

// A Bot's own chat or a group chat: pages from `chat` / `room-chat`, new entries and
// the reply being written from the feed. Entries that arrive while the first page loads wait for it.
function useChat(botId, roomId, part, feed) {
  const active = botId !== undefined || roomId !== undefined
  const [view, setView] = useState({ sessionId: null, items: [], cursor: null, loading: active, failed: false })
  const [stream, setStream] = useState(null)
  const [pending, setPending] = useState([])
  const ready = useRef(false)
  const early = useRef([])
  const busy = useRef(false)
  const reloadQueued = useRef(false)
  const gen = useRef(0)
  const hasLoaded = useRef(false)
  const knownUserIds = useRef(new Set())
  const keep = useRef(null)

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
      const page = roomId !== undefined
        ? await call('room-chat', { roomId, ...(cursor ? { cursor } : {}) })
        : await call('chat', { botId, ...(cursor ? { cursor } : {}) })
      if (gen.current !== myGen) return
      const pageItems = roomId !== undefined ? adaptRoomItems(page.items) : (Array.isArray(page.items) ? page.items : [])
      const pageSessionId = page.sessionId ?? part
      if (cursor === undefined) {
        const later = roomId !== undefined
          ? []
          : early.current.filter(entry => entry.sessionId === pageSessionId && !pageItems.some(item => sameItem(item, entry.item)))
        early.current = []
        ready.current = true
        const mergedItems = [...pageItems, ...later.map(entry => entry.item)]
        setView((current) => {
          if (refresh && current.sessionId === pageSessionId && current.items.length > 0) {
            const merged = mergeLatestPage(current.items, current.cursor, mergedItems, page.cursor)
            return { ...current, items: merged.items, cursor: merged.cursor, loading: false, failed: false }
          }
          return { sessionId: pageSessionId, items: mergedItems, cursor: page.cursor, loading: false, failed: false }
        })
        if (roomId !== undefined) {
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
          if (freshUsers.length > 0) {
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
          }
        }
      } else {
        if (roomId !== undefined) {
          for (const item of pageItems) {
            if (item.kind === 'user') knownUserIds.current.add(userItemKey(item))
          }
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
  }, [active, botId, roomId, part])
  const loadRef = useRef(load)
  loadRef.current = load

  // A new part starts the chat over.
  useEffect(() => {
    const myGen = ++gen.current
    busy.current = false
    reloadQueued.current = false
    ready.current = false
    hasLoaded.current = false
    early.current = []
    knownUserIds.current.clear()
    setPending([])
    setStream(null)
    setView({ sessionId: null, items: [], cursor: null, loading: active, failed: false })
    if (active) void loadRef.current(undefined)
    return () => {
      if (gen.current === myGen) gen.current += 1
      busy.current = false
      reloadQueued.current = false
    }
  }, [active, botId, roomId, part])

  useEffect(() => feed.on((event, data) => {
    // The feed came back after a break: entries may have been missed.
    if (event === 'hello') { if (ready.current) void loadRef.current(undefined, undefined, true); return }
    if (roomId !== undefined) {
      if (event === 'room' && data?.roomId === roomId) void loadRef.current(undefined, undefined, true)
      return
    }
    if (botId === undefined || data?.botId !== botId || data.sessionId !== part) return
    if (event === 'message') {
      if (!ready.current) { early.current.push(data); return }
      setView(current => (data.sessionId !== current.sessionId || current.items.some(item => sameItem(item, data.item)) ? current : { ...current, items: [...current.items, data.item] }))
      if (data.item.kind === 'user') {
        setPending((list) => {
          const at = list.findIndex(entry => entry.text === data.item.text)
          return at < 0 ? list : [...list.slice(0, at), ...list.slice(at + 1)]
        })
      }
      if (data.item.kind === 'bot') setStream(null)
    } else if (event === 'stream') {
      if (data.phase === 'start') setStream({ attemptId: data.attemptId, text: '' })
      else if (data.phase === 'end') setStream(current => (current?.attemptId === data.attemptId ? null : current))
      else setStream(current => (current?.attemptId === data.attemptId ? { ...current, text: current.text + data.text } : current))
    }
  }), [feed, botId, roomId, part])

  // Shown at once: the message can come back on the feed before the request returns.
  const send = async (text, actions, sessionId) => {
    const myGen = gen.current
    const entry = { kind: 'user', text, time: Date.now() }
    setPending(list => [...list, entry])
    actions.noteSent(sessionId)
    try {
      await actions.send(sessionId, text)
    } catch (error) {
      if (gen.current === myGen) setPending(list => list.filter(item => item !== entry))
      throw error
    }
  }
  return { view, stream, pending, load, send, keep }
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
export function Chat({ sessionId, team }) {
  const { actions, hooks, chat: feed } = team
  const roster = hooks.useRoster(value => value)
  const bot = roster.byId[sessionId]
  const room = roster.roomsById[sessionId]
  const name = bot?.name ?? room?.name ?? ''
  const { view, stream, pending, load, send, keep } = useChat(bot?.id, room?.id, sessionId, feed)
  useEffect(() => {
    document.body?.toggleAttribute?.('data-bt-room', room !== undefined)
    return () => { document.body?.removeAttribute?.('data-bt-room') }
  }, [room !== undefined])
  const scroller = useRef(null)
  const follow = useRef(true)
  const question = roster.questions?.[sessionId]
  const running = hooks.useSessionStatus(map => map.get(sessionId)?.running === true)
  // A part the user opened while its turn runs takes no input until that turn ends or
  // the user stops it: the same lock and the same dock the plugin puts in DSH.
  const readOnlyPart = hooks.useUi(state => state.readOnlyPart ?? null)
  const partRunning = hooks.useRoster(state => state.partsRunning?.[sessionId] === true)
  const readOnly = readOnlyPart !== null && readOnlyPart === sessionId && partRunning

  useLayoutEffect(() => {
    const node = scroller.current
    if (keep.current !== null) {
      node.scrollTop = node.scrollHeight - keep.current
      keep.current = null
    } else if (follow.current) node.scrollTop = node.scrollHeight
  }, [view.items, stream, pending, running, question])

  const onScroll = () => {
    const node = scroller.current
    follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < FOLLOW_PX
  }
  const earlier = view.loading && view.sessionId !== null ? h(Shimmer, null, t('Loading earlier messages…'))
    : view.failed ? h('button', { type: 'button', className: 'bt-soft', onClick: () => load(view.cursor ?? undefined, scroller.current) }, t('Couldn’t load earlier messages · Retry'))
      : view.cursor ? h('button', { type: 'button', className: 'bt-soft', onClick: () => load(view.cursor, scroller.current) }, t('Load earlier')) : null
  const waiting = bot?.waiting === true

  return h('div', { className: 'dsb-chat' },
    h('div', { ref: scroller, className: 'dsb-scroll', 'data-conversation-scroll': '', onScroll },
      h('div', { className: 'dsb-column' },
        earlier ? h('div', { className: 'bt-earlier-top' }, earlier) : null,
        h('div', { className: 'dsb-flow', 'data-chat-flow': '', role: 'feed', 'aria-label': name, 'aria-busy': view.loading },
          h(ChatRows, { items: view.items, sessionId, roster, actions, useUi: hooks.useUi, clock: true }),
          pending.length ? h('div', { className: 'dsb-pending' }, h(ChatRows, { items: pending, sessionId, roster, actions })) : null,
          stream?.text ? h(Bubbles, { texts: [stream.text], roster, selfId: bot?.id, actions, streaming: true, sessionId }) : null,
          // The Bot views' activity row (from the header pill) draws itself in here.
          h('div', { 'data-chat-running': '' }),
          question ? h(PendingQuestion, { key: JSON.stringify([sessionId, question.id]), sessionId, question, actions, inline: true, enterToSend: sendsOnEnter(roster.prefs) }) : null))),
    h('div', { className: 'dsb-composer-root' },
      h(ModelChoiceDock, { sessionId, useRoster: hooks.useRoster, actions }),
      h(ReadOnlyDock, { sessionId, useUi: hooks.useUi, useRoster: hooks.useRoster, actions }),
      h(Composer, {
        sessionId,
        disabled: waiting || readOnly,
        placeholder: waiting ? t('Pick a model and {name} can start.', { name }) : name ? t('Message {name}', { name }) : t('Message'),
        onSend: text => send(text, actions, sessionId),
        actions,
        useUi: hooks.useUi,
        useRoster: hooks.useRoster,
      })))
}
