import { createElement as h, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { BotMark, RoomAvatar } from './mark.js'
import { isActiveTask, tasksForChat } from './bot-tasks.js'
import { Elapsed, Shimmer, PHRASES } from './cells.js'
import { MoveIcon } from './icons.js'
import { noteClientError } from './diagnostics.js'
import { noHover, reducedEffects, reducedMotion } from './motion.js'
import { hostText, t } from './i18n.js'

// -------------------------------------------------------------------------
// The activity row: the Bot's mark and a shimmering phrase at the transcript
// tail while it works. It lives in the shell's running status, steps aside while a
// reply streams, and holds each phrase long enough to read.

const PHRASE_HOLD_MS = 800
const drawPhrase = pool => t(pool[Math.min(pool.length - 1, Math.floor(Math.random() * pool.length))])
export { reducedMotion }

// A turn that streams text first and runs a tool after keeps its row once the
// tool starts: streaming alone hides it, but running work must not.
export const rowVisible = ({ running, streaming, tools, relaying, bot, room }) =>
  running && (!streaming || tools.length > 0) && !relaying && (bot !== undefined || room !== undefined)

// Active DM background tasks for this Bot (group background tasks already show in
// MemberDock). Returns null when the Bot has no active DM background tasks.
export function backgroundActivity(bot, approvals = []) {
  if (!bot) return null
  const active = tasksForChat({ bot }).filter(isActiveTask)
  if (active.length === 0) return null
  const taskApprovals = (approvals ?? []).filter(entry =>
    entry.roomId === undefined && entry.botId === bot.id && entry.taskId !== undefined && entry.answerable !== false)
  const waitingCount = Math.max(
    active.filter(item => item.status === 'waiting_approval').length,
    taskApprovals.length,
  )
  const needsApproval = waitingCount > 0
  const allWaitingWork = !needsApproval && active.every(item => item.status === 'waiting_work')
  const primary = active[0]
  const title = typeof primary?.title === 'string' ? primary.title.trim() : ''
  const state = needsApproval ? 'alert' : allWaitingWork ? 'waiting' : 'background'
  const label = active.length === 1
    ? needsApproval
      ? (title ? t('Waiting for approval · {title}', { title }) : t('Waiting for approval'))
      : allWaitingWork
        ? (title ? t('Waiting for teammate · {title}', { title }) : t('Waiting for teammate'))
        : (title ? t('In background · {title}', { title }) : t('Working in background'))
    : needsApproval
      ? t('{count} background tasks · {waiting} needs approval', { count: active.length, waiting: waitingCount })
      : t('{count} background tasks running', { count: active.length })
  const starts = active.map(item => item.startedAt ?? item.updatedAt).filter(at => typeof at === 'number' && at > 0)
  const startedAt = starts.length > 0 ? Math.min(...starts) : 0
  return {
    key: `bg:${state}:${label}`,
    label,
    state,
    startedAt,
    count: active.length,
    needsApproval,
    primaryId: primary?.id ?? null,
  }
}

// A queued message waits for the next turn, so only a transcript or steering
// send counts as fresh input; a steer the host saw counts from when it landed.
export const freshInputAt = (submissions, steeredAt) => Math.max(0, steeredAt ?? 0,
  ...(submissions ?? []).filter(sub => sub.placement !== 'queued').map(sub => sub.time))

// The shell's running status renders inside the flow, before its pending steering
// rows, so hosting the row there puts it above an interjection's echo and it jumps
// below the message once the echo commits. The flow is the column around the shell's
// slot: the row mounts at its end, after every row the shell draws, and stays there.
// The slot can sit under wrappers the shell adds around the flow, so the search is a
// descendant one; a flow without a slot falls back to the first flow. No flow at all
// is a mount failure, noted once per page — the observer keeps retrying in case the
// transcript is only mid-mount.
// The slot sits at the end of the flow, so the search walks the whole transcript; it
// runs every frame the transcript changes, so the last slot found is kept while it
// stays in its flow and running. The row lets it go when it stops, so a chat left
// behind is not held in memory.
let mountMissed = false
let runningSlot = null
export function findHost() {
  const kept = runningSlot?.slot
  if (kept?.ownerDocument === document && kept?.isConnected && runningSlot.host?.isConnected && kept.hasAttribute('data-bt-running') && kept.closest('[data-bt-flow]') === runningSlot.host) return runningSlot.host
  const slot = document.querySelector('[data-bt-flow] [data-bt-running]')
  const node = slot?.closest('[data-bt-flow]') ?? document.querySelector('[data-bt-flow]')
  runningSlot = slot ? { slot, host: node } : null
  if (node === null && !mountMissed) {
    mountMissed = true
    noteClientError('activity row', new Error('[data-bt-flow] not found'))
  }
  return node
}

export function releaseHost() {
  runningSlot = null
}

function useRunningHost(active) {
  const [host, setHost] = useState(null)
  useEffect(() => {
    if (!active) { releaseHost(); setHost(null); return undefined }
    let frame = 0
    let currentHost = null
    let currentSlot = null
    const find = () => {
      frame = 0
      const node = findHost()
      currentHost = node
      currentSlot = node && runningSlot?.host === node ? runningSlot.slot : null
      setHost(prev => (prev === node ? prev : node))
    }
    const observer = new MutationObserver(() => {
      if (currentHost?.isConnected && currentSlot?.isConnected && currentSlot.hasAttribute('data-bt-running') && currentHost.contains(currentSlot)) return
      if (!frame) frame = requestAnimationFrame(find)
    })
    observer.observe(document.querySelector('[data-bt-scroll]') ?? document.body, { childList: true, subtree: true })
    find()
    return () => { cancelAnimationFrame(frame); observer.disconnect(); releaseHost() }
  }, [active])
  return host
}

// New rows slide in. The first paint of a transcript, history
// loaded above, and bulk loads arrive without motion.
function useRowEntrances(replacing) {
  const check = useRef(replacing)
  check.current = replacing
  useEffect(() => {
    const seen = new WeakSet()
    const started = Date.now()
    let column = null
    let frame = 0
    let waiting = false
    const settle = (event) => {
      if (event.target !== event.currentTarget || !event.animationName.startsWith('bt-row')) return
      delete event.currentTarget.dataset.btEnter
      event.currentTarget.removeEventListener('animationend', settle)
    }
    const scan = () => {
      frame = 0
      const next = column?.isConnected ? column : document.querySelector('[data-bt-flow]')
      if (next !== column) {
        observer.disconnect()
        column = next
        if (column) {
          waiting = false
          observer.observe(column, { childList: true })
        }
      }
      if (!column) {
        if (!waiting) {
          waiting = true
          observer.observe(document.querySelector('[data-bt-scroll]') ?? document.body, { childList: true, subtree: true })
        }
        return
      }
      const items = []
      for (const child of column.children) {
        if (child.hasAttribute('data-bt-flow-key')) items.push(child)
      }
      let last = -1
      for (let index = 0; index < items.length; index += 1) {
        if (seen.has(items[index])) last = index
      }
      if (reducedEffects()) return
      if (last < 0 || Date.now() - started < 800) {
        for (const item of items) {
          if (!seen.has(item) && item.offsetHeight > 0) seen.add(item)
        }
        return
      }
      const fresh = []
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index]
        if (seen.has(item)) continue
        if (item.offsetHeight > 0) fresh.push({ item, index })
      }
      for (const entry of fresh) seen.add(entry.item)
      if (fresh.length > 3) return
      for (const { item, index } of fresh) {
        if (index < last) continue
        const reply = [undefined, 'assistant-step', 'tool-call'].includes(item.dataset.btFlowKind)
        item.dataset.btEnter = reply && check.current() ? 'after-collapse' : 'new'
        item.addEventListener('animationend', settle)
      }
    }
    const observer = new MutationObserver(() => { if (!frame) frame = requestAnimationFrame(scan) })
    scan()
    return () => { cancelAnimationFrame(frame); observer.disconnect() }
  }, [])
}

export function ActivityIndicator({ sessionId, away = false, useRoster, useSessionStatus, useLive, useSession, useWork, actions }) {
  const roster = useRoster(value => value)
  const running = useSessionStatus(map => map.get(sessionId)?.running === true)
  const turnAt = useWork?.(work => work.turns?.[sessionId])
  // Until the host reports the turn's start, the clock counts from when this window
  // saw the run begin.
  const runAt = useRef(0)
  if (!running) runAt.current = 0
  else if (runAt.current === 0) runAt.current = Date.now()
  const liveKey = useLive(state => JSON.stringify(state[sessionId] ?? {}))
  const steeredAt = useWork?.(work => work.steered?.[sessionId])
  const bgInfo = useWork?.(work => work.canBackground?.[sessionId])
  const rowRef = useRef(null)
  const [movingBg, setMovingBg] = useState(false)
  const [bgOpen, setBgOpen] = useState(false)
  useEffect(() => { setMovingBg(false); setBgOpen(false) }, [sessionId, bgInfo?.turn])
  useEffect(() => {
    if (!bgOpen) return undefined
    const onDown = (event) => {
      if (!rowRef.current?.contains(event.target)) setBgOpen(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [bgOpen])
  const pendingInput = useSession(snapshot => freshInputAt(snapshot?.pendingSubmissions, steeredAt))
  const bot = roster.byId[sessionId]
  const room = roster.roomsById[sessionId]
  // The one switch the row names: a working-folder move jumps the chat to a fresh
  // part while a turn is not running, so without it the conversation just empties.
  const moveAt = useWork?.((work) => {
    const entry = bot !== undefined ? work.bots?.[bot.id]
      : room !== undefined ? work.rooms?.[room.id]?.find(item => item.self === true) : undefined
    return entry?.switching === true && entry.folder === true && entry.roomId === undefined ? entry.since : 0
  }) ?? 0
  const bgApprovalsKey = useWork?.(work => (bot !== undefined
    ? JSON.stringify((work.approvals ?? []).filter(entry => entry.roomId === undefined && entry.botId === bot.id && entry.taskId !== undefined && entry.answerable !== false))
    : '')) ?? ''
  const bgApprovals = useMemo(() => (bgApprovalsKey ? JSON.parse(bgApprovalsKey) : []), [bgApprovalsKey])
  const entries = useMemo(() => Object.values(JSON.parse(liveKey)), [liveKey])
  const streaming = entries.some(entry => entry.text)
  const tools = entries.filter(entry => !entry.text).sort((a, b) => a.at - b.at)
  // Group chats show who is typing on their own while members speak.
  const relaying = tools.some(entry => entry.relay)
  const fgVisible = rowVisible({ running, streaming, tools, relaying, bot, room })
  const bgTask = !away && bot !== undefined && !running && moveAt === 0 ? backgroundActivity(bot, bgApprovals) : null
  const visible = moveAt !== 0 || fgVisible || bgTask !== null
  const tool = tools.at(-1)
  const inputRef = useRef(0)
  // A steer keeps the run going, so nothing else resets the row: fresh input is
  // the newest activity, and the phrase and the clock restart from the send.
  const inputAt = Math.max(inputRef.current, pendingInput)
  inputRef.current = inputAt
  const want = !visible ? null
    : moveAt !== 0 ? { key: 'move', label: t('Switching working folder'), state: 'thinking' }
      : fgVisible
        ? inputAt > (tool?.at ?? 0)
          ? { key: `input:${inputAt}`, pool: PHRASES.thinking, state: 'thinking' }
          : tool ? { key: tool.label ? `tool:${tool.label}` : 'working', label: tool.label, pool: PHRASES.working, state: tool.state ?? 'working' }
            : { key: 'thinking', pool: PHRASES.thinking, state: 'thinking' }
        : { key: bgTask.key, label: bgTask.label, state: bgTask.state }
  const [shown, setShown] = useState(null)
  const wantKey = want?.key ?? null
  const markState = useRef('thinking')
  if (want) markState.current = want.state
  useEffect(() => {
    if (wantKey === null || shown?.key === wantKey) return undefined
    const make = () => setShown({ key: wantKey, text: want.label ?? drawPhrase(want.pool), at: Date.now() })
    const wait = shown ? shown.at + PHRASE_HOLD_MS - Date.now() : 0
    if (wait <= 0) { make(); return undefined }
    const timer = setTimeout(make, wait)
    return () => clearTimeout(timer)
  }, [wantKey, shown])
  const [phase, setPhase] = useState(null)
  const endedAt = useRef(0)
  const shift = useRef(null)
  const leaving = useRef(false)
  leaving.current = phase !== null && !visible
  useEffect(() => {
    if (visible) { setPhase('in'); return undefined }
    setPhase(current => (current === 'in' ? 'out' : current))
    const timer = setTimeout(() => {
      shift.current = document.querySelector('[data-bt-scroll]')?.scrollTop ?? null
      setPhase(current => (current === 'out' ? null : current))
    }, reducedMotion() ? 0 : 140)
    return () => clearTimeout(timer)
  }, [visible])
  // Removing the row at a pinned tail moves the transcript down; a tail
  // shift eases that collapse instead of jumping.
  useLayoutEffect(() => {
    if (phase !== null) return
    endedAt.current = Date.now()
    setShown(null)
    const before = shift.current
    shift.current = null
    const scroller = document.querySelector('[data-bt-scroll]')
    if (before === null || !scroller || reducedMotion()) return
    const delta = before - scroller.scrollTop
    if (delta > 0) scroller.querySelector('[data-bt-flow]')?.animate([{ transform: `translateY(${-delta}px)` }, { transform: 'none' }], { duration: 140, easing: 'cubic-bezier(.23,1,.32,1)' })
  }, [phase])
  // Cancelled tools never report a result, so their notes end with the run.
  useEffect(() => { if (!running) actions.clearLive(sessionId) }, [running, sessionId])
  // Only rows that take the activity row's place grow out of it.
  useRowEntrances(() => leaving.current || Date.now() - endedAt.current < 300)
  const host = useRunningHost(running || moveAt !== 0 || bgTask !== null)
  if (!host || phase === null || !shown) return null
  const showBgAction = bot !== undefined && running && moveAt === 0 && bgInfo !== undefined && typeof actions?.moveToBackground === 'function'
  const moveToBg = () => {
    if (movingBg || !bgInfo) return
    setMovingBg(true)
    setBgOpen(false)
    void Promise.resolve(actions.moveToBackground(bgInfo.botId, sessionId, bgInfo.turn))
      .catch(error => {
        setMovingBg(false)
        actions.reportError?.(new Error(hostText(error?.message ?? String(error))), 'move-to-background')
      })
  }
  const tapRow = (event) => {
    if (!showBgAction || movingBg || !noHover()) return
    const target = event?.target
    if (typeof target?.closest === 'function' && target.closest('button,.bt-typing-mark')) return
    setBgOpen(open => !open)
  }
  const canOpenTasks = bgTask !== null && (typeof actions?.toggleTaskDeck === 'function' || typeof actions?.openTaskDeck === 'function')
  const openTasks = () => {
    if (!bot) return
    if (typeof actions?.toggleTaskDeck === 'function') actions.toggleTaskDeck(bot.id)
    else actions?.openTaskDeck?.(bot.id, bgTask?.primaryId ?? null)
  }
  const elapsedAt = moveAt !== 0 ? moveAt
    : bgTask !== null ? bgTask.startedAt
      : Math.max(turnAt ?? runAt.current, inputAt)
  const textContent = [
    bgTask?.needsApproval ? h('span', { key: 'dot', className: 'bt-typing-dot', 'aria-hidden': true }) : null,
    h('span', { key: `${shown.key}:${shown.at}`, className: 'bt-typing-label' }, h(Shimmer, null, `${shown.text}…`)),
    elapsedAt > 0 ? h(Elapsed, { key: 'time', at: elapsedAt, className: 'bt-typing-time' }) : null,
  ]
  return createPortal(h('div', {
    ref: rowRef,
    className: 'bt-typing',
    'data-exiting': phase === 'out' ? '' : undefined,
    'data-bg-task': bgTask !== null ? '' : undefined,
    'data-bg-open': showBgAction && bgOpen ? '' : undefined,
    'data-bg-busy': showBgAction && movingBg ? '' : undefined,
    onClick: tapRow,
  },
    h('span', { className: 'bt-typing-mark', 'aria-hidden': true },
      bot ? h(BotMark, { bot, size: 28, state: markState.current, live: true, pokeable: true }) : h(RoomAvatar, { room, roster, size: 28 })),
    canOpenTasks
      ? h('button', {
          type: 'button',
          className: 'bt-typing-text bt-typing-task',
          'data-approval': bgTask.needsApproval || undefined,
          'aria-label': `${shown.text} · ${t('View background tasks')}`,
          title: t('View background tasks'),
          onClick: openTasks,
        }, ...textContent)
      : h('span', { className: 'bt-typing-text', 'aria-hidden': true }, ...textContent),
    showBgAction
      ? h('span', { className: 'bt-typing-bg-wrap' },
        h('span', { className: 'bt-typing-bg-in' },
          h('button', {
            type: 'button',
            className: 'bt-typing-bg',
            disabled: movingBg,
            'aria-label': t('Move current work to background'),
            title: t('Move current work to background'),
            onClick: moveToBg,
          },
          h('span', { className: 'bt-typing-bg-ico', 'aria-hidden': true }, h(MoveIcon)),
          h('span', null, movingBg ? t('Moving…') : t('Move to background')))))
      : null), host)
}
