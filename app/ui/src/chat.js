import { createElement as h, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { chatOfSession } from '../../../ds-bot/src/client/draft-keep.js'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { currentPart } from '../../../ds-bot/src/client/text.js'
import { TextSelectionAction } from '../../../ds-bot/src/client/text-annotation.js'
import { Transcript, adaptRoomItem, adaptRoomItems, mergeIncrementalItems, mergeLatestPage } from './chat-transcript.js'
import {
  ComposerArea,
  bytesToBase64,
  clearFailedSends,
  pruneFailedSends,
  stageAttachmentItems,
  withdrawQueuedText,
} from './composer-area.js'
import { revokeUrl } from './failed-send-bar.js'
import { queueRowText } from './queue-dock.js'

const EMPTY_OBJ = {}
const EMPTY_LIST = Object.freeze([])
const NO_OBJ_HOOK = selector => selector(EMPTY_OBJ)

export {
  ComposerArea,
  Transcript,
  adaptRoomItem,
  adaptRoomItems,
  bytesToBase64,
  clearFailedSends,
  mergeIncrementalItems,
  mergeLatestPage,
  pruneFailedSends,
}

let pendingSendSeq = 0

function hasFileDrag(dataTransfer) {
  const types = dataTransfer?.types
  if (!types) return false
  if (typeof types.includes === 'function') return types.includes('Files')
  return Array.from(types).includes('Files')
}

function revokeEntryUrls(entry) {
  if (entry?.settled !== true || entry.revoked === true) return
  entry.revoked = true
  for (const url of entry.previewUrls ?? []) revokeUrl(url)
}

const SELECTION_SESSION_STATE = Object.freeze({ removed: false, subagent: null })
const useSelectionSession = selector => selector(SELECTION_SESSION_STATE)
const selectionHostT = key => (key === 'quote.add' ? t('Quote') : t(key))

function selectionElementOf(node) {
  if (!node) return null
  return node.nodeType === 1 ? node : node.parentElement ?? null
}

const TextSelectionOverlay = memo(function TextSelectionOverlay({ sessionId, containerRef, insertQuoteRef, disabled, actions, useRoster }) {
  const [selection, setSelection] = useState(null)
  const [box, setBox] = useState(null)
  const hostRef = useRef(null)
  const seqRef = useRef(0)

  const dismiss = useCallback(() => {
    setSelection(null)
    setBox(null)
  }, [])

  const clearSelection = useCallback(() => {
    try { window.getSelection?.()?.removeAllRanges?.() } catch { /* ignore */ }
  }, [])

  const readText = useCallback(() => {
    const raw = window.getSelection?.()?.toString?.() ?? ''
    if (raw.trim() !== '') return raw.trim()
    return selection?.text ?? null
  }, [selection])

  const inputActions = useMemo(() => ({
    insertQuote: (raw) => {
      if (typeof insertQuoteRef?.current !== 'function') return false
      return insertQuoteRef.current(raw) === true
    },
  }), [insertQuoteRef])

  const place = useCallback((rect) => {
    if (!rect || typeof window === 'undefined') return null
    const pad = 12
    const vw = window.innerWidth || 1280
    const vh = window.innerHeight || 800
    const measuredW = hostRef.current?.offsetWidth || 160
    const measuredH = hostRef.current?.offsetHeight || 36
    const centerX = rect.left + rect.width / 2
    const left = Math.max(pad, Math.min(vw - measuredW - pad, Math.round(centerX - measuredW / 2)))
    const preferTop = Math.round(rect.top - measuredH - 8)
    const top = preferTop >= pad ? preferTop : Math.max(pad, Math.min(vh - measuredH - pad, Math.round(rect.bottom + 8)))
    return { left, top }
  }, [])

  const interactingRef = useRef(false)
  const hasSelection = selection !== null

  useEffect(() => {
    interactingRef.current = false
    dismiss()
  }, [sessionId, disabled, dismiss])

  useEffect(() => {
    if (disabled || typeof document === 'undefined' || typeof window === 'undefined') return undefined
    const isInHost = (node) => Boolean(hostRef.current && node && hostRef.current.contains(node))
    const capture = (event) => {
      if (isInHost(event?.target) || isInHost(document.activeElement) || interactingRef.current) return
      const container = containerRef.current
      const sel = window.getSelection?.()
      if (!container || !sel || sel.isCollapsed || sel.rangeCount === 0) {
        dismiss()
        return
      }
      const text = sel.toString().trim()
      if (text === '') {
        dismiss()
        return
      }
      const range = sel.getRangeAt(0)
      const anchorEl = selectionElementOf(range.startContainer)
      const focusEl = selectionElementOf(range.endContainer)
      if (!anchorEl || !focusEl || !container.contains(anchorEl) || !container.contains(focusEl)) {
        dismiss()
        return
      }
      if (!anchorEl.closest?.('[data-text-interaction-source]') || !focusEl.closest?.('[data-text-interaction-source]')) {
        dismiss()
        return
      }
      const rect = range.getBoundingClientRect()
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        dismiss()
        return
      }
      const nextRect = { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height }
      setSelection((prev) => {
        if (prev && prev.text === text && Math.abs(prev.rect.top - nextRect.top) < 2 && Math.abs(prev.rect.left - nextRect.left) < 2) {
          return prev
        }
        seqRef.current += 1
        return { key: seqRef.current, text, rect: nextRect }
      })
    }
    document.addEventListener('mouseup', capture)
    document.addEventListener('keyup', capture)
    return () => {
      document.removeEventListener('mouseup', capture)
      document.removeEventListener('keyup', capture)
    }
  }, [disabled, containerRef, dismiss])

  useEffect(() => {
    if (!hasSelection || disabled || typeof document === 'undefined' || typeof window === 'undefined') {
      interactingRef.current = false
      return undefined
    }
    const isInHost = (node) => Boolean(hostRef.current && node && hostRef.current.contains(node))
    const onPointerDown = (event) => {
      if (isInHost(event.target)) {
        interactingRef.current = true
        return
      }
      interactingRef.current = false
      setSelection(prev => (prev ? null : prev))
      setBox(prev => (prev ? null : prev))
    }
    const onFocusIn = (event) => {
      if (isInHost(event.target)) interactingRef.current = true
    }
    const onSelectionChange = () => {
      if (interactingRef.current || isInHost(document.activeElement)) return
      const sel = window.getSelection?.()
      if (!sel || sel.isCollapsed || sel.toString().trim() === '') dismiss()
    }
    const onScroll = () => {
      if (interactingRef.current || isInHost(document.activeElement)) return
      dismiss()
    }
    const scroller = containerRef.current
    document.addEventListener('selectionchange', onSelectionChange)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('focusin', onFocusIn, true)
    scroller?.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('focusin', onFocusIn, true)
      scroller?.removeEventListener('scroll', onScroll)
    }
  }, [hasSelection, disabled, containerRef, dismiss])

  useLayoutEffect(() => {
    if (!selection) { setBox(null); return undefined }
    const reposition = () => setBox(place(selection.rect))
    reposition()
    window.addEventListener('resize', reposition)
    return () => window.removeEventListener('resize', reposition)
  }, [selection, place])

  if (!selection || disabled || typeof document === 'undefined' || !document.body) return null
  const style = box ? { left: `${box.left}px`, top: `${box.top}px` } : { left: `${Math.max(12, Math.round(selection.rect.left))}px`, top: `${Math.max(12, Math.round(selection.rect.top - 44))}px`, visibility: 'hidden' }
  return createPortal(
    h('div', { ref: hostRef, className: 'dsb-selection-host', style },
      h(TextSelectionAction, {
        key: selection.key,
        sessionId,
        dismiss,
        readText,
        clearSelection,
        inputActions,
        useSession: useSelectionSession,
        useRoster,
        actions,
        t: selectionHostT,
      })),
    document.body,
  )
})

// One conversation in the main view, split into `Transcript` (subscribes to the live
// streaming session log) and `ComposerArea` (composer, docks, and queue, isolated from
// streaming frames so streaming tokens never re-render the input or docks).
export function Chat({ sessionId, team, registry, classic = false }) {
  const { actions, hooks, chat: feed } = team
  const roster = hooks.useRoster(value => value)
  const bot = roster.byId[sessionId]
  const room = roster.roomsById[sessionId]
  const isRoom = room !== undefined
  // Always follow the Bot's current segment (parts may roll over mid-conversation).
  const activeSessionId = isRoom ? sessionId : (bot ? currentPart(bot) : sessionId)
  const agentId = !isRoom && !bot ? (roster.agentOf?.[activeSessionId] ?? roster.agentOf?.[sessionId]) : undefined
  const isAgent = agentId !== undefined
  const isClassic = Boolean(classic || isAgent)
  const name = bot?.name ?? room?.name ?? (isAgent ? 'DSH Agent' : '')

  const [pending, setPending] = useState([])
  const [dragging, setDragging] = useState(false)
  const [subagentStack, setSubagentStack] = useState([])
  const [dmWriting, setDmWriting] = useState(false)
  const sendGen = useRef(0)
  const dragDepth = useRef(0)
  const addFilesRef = useRef(undefined)
  const withdrawRef = useRef(undefined)
  const insertQuoteRef = useRef(undefined)
  const runningRef = useRef(false)
  const transcriptRef = useRef(null)
  const pendingRef = useRef(undefined)
  pendingRef.current = pending
  const isRoomRef = useRef(isRoom)
  isRoomRef.current = isRoom
  const chatRef = useRef(null)
  const composerRootRef = useRef(null)
  const scroller = useRef(null)
  const seenQueuedIdsRef = useRef(new Set())

  useEffect(() => {
    sendGen.current += 1
    setSubagentStack([])
    setDmWriting(false)
    seenQueuedIdsRef.current = new Set()
    setPending((list) => {
      for (const entry of list) {
        entry.removed = true
        revokeEntryUrls(entry)
      }
      return []
    })
  }, [activeSessionId])

  useEffect(() => () => {
    for (const entry of pendingRef.current ?? []) {
      entry.removed = true
      revokeEntryUrls(entry)
    }
  }, [])

  const onWritingChange = useCallback((next) => {
    const flag = Boolean(next)
    setDmWriting(prev => (prev === flag ? prev : flag))
  }, [])

  const clearPendingUsers = useCallback((freshUsers, initial) => {
    setPending((list) => {
      if (list.length === 0) return list
      const next = list.slice()
      const removed = []
      for (const item of freshUsers) {
        const itemImages = item.images ?? item.imageRefs?.length ?? 0
        const itemFiles = item.fileCount ?? item.fileRefs?.length ?? (Array.isArray(item.files) ? item.files.length : 0)
        const at = next.findIndex(entry => entry.text === item.text
          && entry.imageCount === itemImages
          && entry.fileCount === itemFiles
          && (!initial || !Number.isFinite(item.time) || item.time >= entry.time - 2000))
        if (at >= 0) removed.push(...next.splice(at, 1))
      }
      for (const entry of removed) {
        entry.removed = true
        revokeEntryUrls(entry)
      }
      return next.length === list.length ? list : next
    })
  }, [])

  const onSessionUser = useCallback((text, time, initial, summary) => {
    clearPendingUsers([{
      text,
      time,
      images: summary?.images ?? 0,
      fileCount: summary?.files ?? 0,
    }], initial)
  }, [clearPendingUsers])

  const viewingSubagent = !isRoom && subagentStack.length > 0 ? subagentStack.at(-1) : null
  const viewedSessionId = viewingSubagent ? viewingSubagent.sessionId : activeSessionId
  const subagentAncestors = useMemo(() => {
    if (!viewingSubagent || subagentStack.length <= 1 || !activeSessionId) return undefined
    return [
      { sessionId: activeSessionId },
      ...subagentStack.slice(0, -1).map(item => ({ sessionId: item.sessionId, ...(item.mode ? { mode: item.mode } : {}) })),
    ]
  }, [viewingSubagent, subagentStack, activeSessionId])
  const openSubagent = useCallback((entry) => {
    if (!entry?.sessionId || !entry?.parentSessionId) return
    transcriptRef.current?.resetFollow?.()
    setSubagentStack(prev => (prev.at(-1)?.sessionId === entry.sessionId ? prev : [...prev, entry]))
  }, [])
  const popSubagent = useCallback(() => {
    transcriptRef.current?.resetFollow?.()
    setSubagentStack(prev => prev.slice(0, -1))
  }, [])
  const selectSubagentDepth = useCallback((depth) => {
    transcriptRef.current?.resetFollow?.()
    setSubagentStack(prev => prev.slice(0, Math.max(0, depth)))
  }, [])

  useEffect(() => {
    document.body?.toggleAttribute?.('data-bt-room', isRoom)
    return () => { document.body?.removeAttribute?.('data-bt-room') }
  }, [isRoom])

  useEffect(() => {
    const root = composerRootRef.current
    const chatEl = chatRef.current
    if (!root || !chatEl) return undefined
    const writeHeight = () => {
      const hPx = Math.round(root.getBoundingClientRect?.().height ?? root.offsetHeight ?? 0)
      if (hPx > 0) chatEl.style.setProperty('--bt-composer-h', `${hPx}px`)
    }
    writeHeight()
    if (typeof ResizeObserver !== 'function') return undefined
    const observer = new ResizeObserver(writeHeight)
    observer.observe(root)
    return () => observer.disconnect()
  }, [])

  // Shown at once: the message can arrive on the follow/feed before the request returns.
  const send = useCallback(async (text, items = [], options = {}) => {
    transcriptRef.current?.followBottom?.()
    const myGen = sendGen.current
    const sendMode = options?.mode === 'steer' ? 'steer' : (options?.mode === 'queue' ? 'queue' : undefined)
    const pendingAttachments = items.map(item => (item.isImage
      ? { type: 'image', attachment: { name: item.name, previewUrl: item.previewUrl } }
      : { type: 'file', attachment: { name: item.name, bytes: item.size } }))
    const imageCount = items.filter(item => item.isImage).length
    const fileCount = items.length - imageCount
    const entry = {
      requestId: `pending-${++pendingSendSeq}`,
      queued: runningRef.current && !isRoomRef.current && sendMode !== 'steer',
      kind: 'user',
      text,
      attachments: pendingAttachments,
      imageCount,
      fileCount,
      previewUrls: items.map(item => item.previewUrl).filter(Boolean),
      settled: false,
      removed: false,
      revoked: false,
      time: Date.now(),
    }
    setPending(list => [...list, entry])
    const cancelSent = actions.noteSent(activeSessionId, { requestId: entry.requestId, text: entry.text, time: entry.time })
    const dispatchSend = async (forceReupload) => {
      const { images: imageIds, files: fileIds } = await stageAttachmentItems(items, actions, {
        forceReupload,
        pendingUploads: options?.pendingUploads,
        limits: options?.limits,
      })
      const sendOpts = {
        ...(imageIds.length > 0 ? { images: imageIds } : {}),
        ...(fileIds.length > 0 ? { files: fileIds } : {}),
        ...(sendMode === 'steer' ? { mode: 'steer' } : {}),
      }
      if (Object.keys(sendOpts).length > 0) {
        await actions.send(activeSessionId, text, sendOpts)
      } else {
        await actions.send(activeSessionId, text)
      }
    }
    try {
      try {
        await dispatchSend(false)
      } catch (firstError) {
        const hadPreStaged = items.some(item => Boolean(item?.stagedId))
        if (firstError?.code === 'bot/stale' && hadPreStaged) {
          await dispatchSend(true)
        } else {
          throw firstError
        }
      }
      // Ownership of previewUrls transfers here: if pending already cleared (e.g. fast SSE or
      // rollover before React committed a re-render), revoke immediately via `entry.removed`.
      entry.settled = true
      if (entry.removed) revokeEntryUrls(entry)
    } catch (error) {
      if (typeof cancelSent === 'function') cancelSent()
      if (sendGen.current === myGen) {
        entry.removed = true
        setPending(list => list.filter(item => item !== entry))
      }
      throw error
    }
  }, [activeSessionId, actions])

  const readOnly = Boolean(roster.readOnly)
  const roomId = room?.id
  const botId = bot?.id
  const onStop = useMemo(() => {
    if (readOnly) return undefined
    if (isRoom) {
      return typeof actions.stopRoomWork === 'function' && roomId ? () => actions.stopRoomWork(roomId) : undefined
    }
    if (botId && typeof actions.stopChat === 'function') return () => actions.stopChat(botId)
    if (agentId && typeof actions.stopAgent === 'function') return () => actions.stopAgent(agentId, activeSessionId)
    return undefined
  }, [readOnly, isRoom, roomId, botId, agentId, activeSessionId, actions])

  // Only lock the composer while waiting for an initial model assignment (no model set yet).
  // Once a Bot has a model (even if kickoff was held after a blocking failure), keep input editable.
  const waitingForModel = bot?.waiting === true && !bot?.model
  const locked = waitingForModel || readOnly
  const useSessionQueues = hooks.useSessionQueues ?? NO_OBJ_HOOK

  // Once an optimistic message lands in the live Queue Dock, drop its faded pending bubble
  // from the transcript so queued messages are never shown twice. Track seen queue item IDs
  // so an already-queued identical message never clears a second in-flight send early.
  const queuedRows = useSessionQueues(map => map?.[activeSessionId] ?? EMPTY_LIST)
  useEffect(() => {
    if (!Array.isArray(queuedRows) || queuedRows.length === 0) return
    const seen = seenQueuedIdsRef.current
    const freshRows = []
    for (const row of queuedRows) {
      const rowId = typeof row?.id === 'string' ? row.id : ''
      if (rowId !== '') {
        if (seen.has(rowId)) continue
        seen.add(rowId)
      }
      freshRows.push(row)
    }
    if (freshRows.length === 0) return
    const queuedUsers = freshRows.map((row) => {
      const blocks = Array.isArray(row?.content) ? row.content : []
      let images = 0
      let files = 0
      for (const block of blocks) {
        if (block?.type === 'image') images += 1
        else if (block?.type === 'file') files += 1
      }
      return { text: queueRowText(blocks), images, fileCount: files }
    })
    clearPendingUsers(queuedUsers, false)
  }, [queuedRows, clearPendingUsers])

  const onDragEnter = (event) => {
    if (locked || !hasFileDrag(event.dataTransfer)) return
    event.preventDefault()
    dragDepth.current += 1
    setDragging(true)
  }
  const onDragOver = (event) => {
    if (locked || !hasFileDrag(event.dataTransfer)) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  }
  const onDragLeave = (event) => {
    if (dragDepth.current === 0) return
    event.preventDefault()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }
  const onDrop = (event) => {
    dragDepth.current = 0
    setDragging(false)
    if (locked || !event.dataTransfer?.files?.length) return
    event.preventDefault()
    addFilesRef.current?.(event.dataTransfer.files)
  }

  const activeChatId = chatOfSession(roster, activeSessionId)?.id ?? null
  const activeChatKey = activeChatId ?? activeSessionId
  const onWithdraw = useCallback(
    text => withdrawQueuedText({ chatId: activeChatId, chatKey: activeChatKey, sessionId: activeSessionId, text }),
    [activeChatId, activeChatKey, activeSessionId],
  )
  const transcriptPending = useMemo(() => pending.filter(entry => !entry.queued), [pending])
  const pendingQueue = useMemo(
    () => pending.filter(entry => entry.queued).map(entry => ({
      requestId: entry.requestId,
      text: entry.text,
      attachments: (entry.attachments ?? []).map(att => (att.type === 'image'
        ? { type: 'image', value: { previewUrl: att.attachment?.previewUrl, name: att.attachment?.name } }
        : { type: 'file', value: { name: att.attachment?.name, bytes: att.attachment?.bytes } })),
    })),
    [pending],
  )

  return h('div', {
    ref: chatRef,
    className: isClassic ? 'dsb-chat dsb-classic-chat' : 'dsb-chat',
    'data-classic': isClassic ? '' : undefined,
    'data-dragging': dragging || undefined,
    onDragEnter,
    onDragOver,
    onDragLeave,
    onDrop,
  },
  dragging ? h('div', { className: 'dsb-dropzone', 'aria-hidden': true },
    h('div', { className: 'dsb-dropzone-card' }, t('Drop files to attach'))) : null,
  h(Transcript, {
    sessionId,
    activeSessionId,
    viewedSessionId,
    viewingSubagent,
    subagentStack,
    subagentAncestors,
    bot,
    room,
    isRoom,
    isAgent,
    isClassic,
    name,
    readOnly,
    pending,
    transcriptPending,
    scrollerRef: scroller,
    transcriptRef,
    onClearPendingUsers: clearPendingUsers,
    onSessionUser,
    onWritingChange,
    onOpenSubagent: openSubagent,
    onPopSubagent: popSubagent,
    onSelectSubagentDepth: selectSubagentDepth,
    actions,
    hooks,
    feed,
    registry,
  }),
  h(ComposerArea, {
    activeSessionId,
    botId,
    isRoom,
    isClassic,
    name,
    locked,
    waitingForModel,
    readOnly,
    viewingSubagent,
    dmWriting,
    pendingQueue,
    composerRootRef,
    addFilesRef,
    withdrawRef,
    insertQuoteRef,
    runningRef,
    onSend: send,
    onStop,
    onWithdraw,
    popSubagent,
    actions,
    hooks,
    feed,
  }),
  !viewingSubagent && !readOnly ? h(TextSelectionOverlay, {
    sessionId: activeSessionId,
    containerRef: scroller,
    insertQuoteRef,
    disabled: locked,
    actions,
    useRoster: hooks.useRoster,
  }) : null)
}
