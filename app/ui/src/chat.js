import { createElement as h, Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { call } from '../../../ds-bot/src/client/api.js'
import { BtwDock } from '../../../ds-bot/src/client/btw.js'
import { ChatRows, Shimmer } from '../../../ds-bot/src/client/cells.js'
import { ComposerPlus, ComposerVoice } from '../../../ds-bot/src/client/composer.js'
import { AppAccessDock, ComputerHandoffDock } from '../../../ds-bot/src/client/computer.js'
import { ConnectorDock, MailDock } from '../../../ds-bot/src/client/connectors.js'
import { chatOfSession, keepDraft, takeDraft } from '../../../ds-bot/src/client/draft-keep.js'
import { fileExtension, fileSizeText } from '../../../ds-bot/src/client/dsh-primitives.js'
import { isImeComposing, sendsOnEnter } from '../../../ds-bot/src/client/enter-key.js'
import { HandoffDock } from '../../../ds-bot/src/client/handoff-card.js'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { ArrowUpIcon, CloseIcon, FileIcon, FolderIcon, PaperclipIcon, PlusIcon, StopIcon, TerminalIcon } from '../../../ds-bot/src/client/icons.js'
import { LearningDock } from '../../../ds-bot/src/client/learning-card.js'
import { MemberDock } from '../../../ds-bot/src/client/member-status.js'
import { ModelChoiceDock } from '../../../ds-bot/src/client/model-menu.js'
import { stepMenuFocus, useLinger, useViewport, viewBottom } from '../../../ds-bot/src/client/motion.js'
import { PasteCard, foldPastedText, pastedName } from '../../../ds-bot/src/client/paste-card.js'
import { mergeRescuedDraft, readRescuedForChat } from '../../../ds-bot/src/client/question-draft.js'
import { QuestionDock } from '../../../ds-bot/src/client/questions.js'
import { SecretDock } from '../../../ds-bot/src/client/secret-card.js'
import { writingBlocks } from '../../../ds-bot/src/client/session-log.js'
import { STORAGE } from '../../../ds-bot/src/client/storage.js'
import { currentPart } from '../../../ds-bot/src/client/text.js'
import { WidgetDock } from '../../../ds-bot/src/client/widget-cell.js'
import { ApprovalDock } from './approval-dock.js'
import { AgentEmptyHero } from './classic-sidebar.js'
import { ComposerMenu, activeComposerTrigger, applyTriggerText, buildComposerMenuItems } from './composer-menus.js'
import { SessionTranscript, UserAttachments, useSessionFollow } from './session-chat.js'

// The chat follows its end while the user is this close to it.
const FOLLOW_PX = 80
const STAGED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024
// Matches host STAGED_TOTAL_MAX (64 MB) using the same accounting (base64 length for images, raw bytes for files).
const MAX_BATCH_STAGED_BYTES = 64 * 1024 * 1024
const stagedByteCost = (size, isImage) => (isImage ? Math.ceil(size / 3) * 4 : size)
const EMPTY_OBJ = {}
const EMPTY_WORK = { bots: {}, approvals: [] }
const NO_OBJ_HOOK = selector => selector(EMPTY_OBJ)
const MemoChatRows = typeof memo === 'function' ? memo(ChatRows) : ChatRows
const NO_WORK_HOOK = selector => selector(EMPTY_WORK)

export function bytesToBase64(bytes) {
  if (typeof globalThis.btoa === 'function') {
    const CHUNK = 0x2000
    let binary = ''
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
    }
    return globalThis.btoa(binary)
  }
  if (typeof globalThis.Buffer === 'function') {
    return globalThis.Buffer.from(bytes).toString('base64')
  }
  return ''
}

async function fileToBase64(file) {
  if (typeof file?.arrayBuffer === 'function') {
    const buf = await file.arrayBuffer()
    return bytesToBase64(new Uint8Array(buf))
  }
  if (typeof globalThis.FileReader === 'function') {
    return new Promise((resolve, reject) => {
      const reader = new globalThis.FileReader()
      reader.onload = () => {
        const result = String(reader.result ?? '')
        const comma = result.indexOf(',')
        resolve(comma >= 0 ? result.slice(comma + 1) : result)
      }
      reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'))
      reader.readAsDataURL(file)
    })
  }
  return ''
}

function filesFromClipboard(clipboardData) {
  if (!clipboardData) return []
  const out = []
  const items = clipboardData.items ? Array.from(clipboardData.items) : []
  for (const item of items) {
    if (item?.kind === 'file' && typeof item.getAsFile === 'function') {
      const file = item.getAsFile()
      if (file) out.push(file)
    }
  }
  if (out.length > 0) return out
  return clipboardData.files ? Array.from(clipboardData.files) : []
}

function hasFileDrag(dataTransfer) {
  const types = dataTransfer?.types
  if (!types) return false
  if (typeof types.includes === 'function') return types.includes('Files')
  return Array.from(types).includes('Files')
}

function revokeUrl(url) {
  if (url && typeof URL?.revokeObjectURL === 'function') URL.revokeObjectURL(url)
}

function revokeEntryUrls(entry) {
  if (entry?.settled !== true || entry.revoked === true) return
  entry.revoked = true
  for (const url of entry.previewUrls ?? []) revokeUrl(url)
}
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
      ...(item.changes ? { changes: item.changes } : {}),
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

const EMPTY_SESSIONS = { ids: [], byId: {} }
const NO_SESSIONS_HOOK = selector => selector(EMPTY_SESSIONS)
// Per-chat monotonic revision tracking ownership of the saved draft slot so a late
// unmounted send failure never overwrites a newer draft written after switching chats.
const draftRevisions = new Map()
const writeDraft = (entry) => {
  const next = (draftRevisions.get(entry.chatId) ?? 0) + 1
  draftRevisions.set(entry.chatId, next)
  keepDraft(entry)
  return next
}

function readSavedDraftText(chatId) {
  if (!chatId) return ''
  try {
    const map = JSON.parse(globalThis.localStorage?.getItem?.(STORAGE.drafts) ?? '{}')
    const entry = map && typeof map === 'object' ? map[chatId] : null
    return typeof entry?.text === 'string' ? entry.text : ''
  } catch {
    return ''
  }
}

// What the Bot views' voice/quote/paste helpers ask of a composer:
// where the caret is, text insertion at caret, and focusing the textarea.
function useInput(field, textRef, setText, setCaret) {
  return useMemo(() => ({
    captureInsertion: () => (field.current ? { start: field.current.selectionStart, end: field.current.selectionEnd } : null),
    insertText: (value, at) => {
      const current = textRef.current ?? ''
      const start = Math.max(0, Math.min(at?.start ?? current.length, current.length))
      const end = Math.max(start, Math.min(at?.end ?? start, current.length))
      const nextText = current.slice(0, start) + value + current.slice(end)
      const nextCaret = start + value.length
      textRef.current = nextText
      setText(nextText)
      setCaret?.(nextCaret)
      const restore = () => {
        const node = field.current
        if (!node) return
        node.focus?.()
        node.setSelectionRange?.(nextCaret, nextCaret)
      }
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restore)
      else restore()
      return true
    },
  }), [field, textRef, setText, setCaret])
}

function ComposerAttachments({ items, onRemove, onPutBackPaste }) {
  if (!items || items.length === 0) return null
  return h('div', { className: 'dsb-attach-rail' }, items.map((item) => {
    if (item.pastedText) {
      return h(PasteCard, {
        key: item.id,
        text: item.pastedText,
        onPutBack: () => onPutBackPaste?.(item),
        onRemove: () => onRemove(item.id),
      })
    }
    const meta = [fileExtension(item.name)?.toUpperCase().slice(0, 8), fileSizeText(item.size)].filter(Boolean).join(' · ')
    if (item.isImage && item.previewUrl) {
      return h('div', { key: item.id, className: 'dsb-attach-thumb', title: item.name },
        h('img', { src: item.previewUrl, alt: item.name }),
        h('button', {
          type: 'button',
          className: 'dsb-attach-x',
          'aria-label': t('Remove {name}', { name: item.name }),
          title: t('Remove'),
          onClick: () => onRemove(item.id),
        }, h(CloseIcon)))
    }
    return h('div', { key: item.id, className: 'dsb-attach-chip', title: item.name },
      h('span', { className: 'dsb-attach-icon', 'aria-hidden': true }, h(FileIcon)),
      h('span', { className: 'dsb-attach-text' },
        h('span', { className: 'dsb-attach-name' }, item.name),
        meta ? h('span', { className: 'dsb-attach-meta' }, meta) : null),
      h('button', {
        type: 'button',
        className: 'dsb-attach-x',
        'aria-label': t('Remove {name}', { name: item.name }),
        title: t('Remove'),
        onClick: () => onRemove(item.id),
      }, h(CloseIcon)))
  }))
}

const keepComposerFocus = event => event.preventDefault()

// The composer's "+" menu for DSH Agent sessions (in Bot & group chats, ComposerPlus owns
// the seat). Shares the exact .bt-plus trigger, spring rotation, and portal menu chrome.
function AgentComposerPlus({ disabled, fileInput, actions }) {
  const [open, setOpen] = useState(false)
  const [shown, leaving] = useLinger(open, 120)
  const buttonRef = useRef(null)
  const menuRef = useRef(null)
  const tick = useViewport()

  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => {
      if (![buttonRef.current, menuRef.current].some(node => node?.contains?.(event.target))) setOpen(false)
    }
    const onKey = (event) => {
      if (stepMenuFocus(menuRef.current, event, buttonRef.current)) return
      if (event.key === 'Escape') {
        event.stopPropagation()
        setOpen(false)
      }
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const place = useMemo(() => {
    if (!shown || !buttonRef.current?.getBoundingClientRect) return null
    const rect = buttonRef.current.getBoundingClientRect()
    const cardTop = buttonRef.current.closest?.('[data-composer-card]')?.getBoundingClientRect?.().top
    const anchorTop = Number.isFinite(cardTop) ? Math.min(rect.top, cardTop) : rect.top
    return { left: rect.left, bottom: viewBottom() - anchorTop + 8 }
  }, [shown, open, tick])

  const canAttach = !disabled
  const canFiles = typeof actions?.openFiles === 'function'
  const canTerminal = !disabled && actions?.canOpenTerminal?.() === true && typeof actions?.newTerminal === 'function'
  const hasAny = canAttach || canFiles || canTerminal

  const attach = () => {
    setOpen(false)
    fileInput?.current?.click?.()
  }
  const openFiles = () => {
    setOpen(false)
    actions.openFiles()
  }
  const openTerminal = () => {
    setOpen(false)
    actions.newTerminal()
  }

  return h(Fragment, null,
    h('button', {
      ref: buttonRef,
      type: 'button',
      className: 'bt-plus',
      disabled: !hasAny,
      'aria-label': t('Add'),
      title: t('Add'),
      'aria-haspopup': 'menu',
      'aria-expanded': Boolean(open),
      onMouseDown: keepComposerFocus,
      onClick: () => { if (hasAny) setOpen(value => !value) },
    }, h(PlusIcon)),
    shown ? createPortal(h('div', {
      ref: menuRef,
      className: 'bt-menu bt-menu-up bt-plus-menu',
      role: 'menu',
      'aria-label': t('Add'),
      style: place ?? {},
      'data-leaving': leaving || undefined,
    },
    canAttach ? h('button', { type: 'button', role: 'menuitem', onClick: attach }, h(PaperclipIcon), h('span', { className: 'bt-menu-label' }, t('Add files'))) : null,
    canFiles ? h('button', { type: 'button', role: 'menuitem', onClick: openFiles }, h(FolderIcon), h('span', { className: 'bt-menu-label' }, t('Files'))) : null,
    canTerminal ? h('button', { type: 'button', role: 'menuitem', onClick: openTerminal }, h(TerminalIcon), h('span', { className: 'bt-menu-label' }, t('Terminal'))) : null), document.body) : null)
}

function Composer({ sessionId, placeholder, disabled, running, onSend, onStop, addFilesRef, actions, feed, useUi, useRoster, useWork, useSessions, useRescuedDrafts }) {
  const roster = useRoster(value => value)
  const sessions = (useSessions ?? NO_SESSIONS_HOOK)(value => value)
  const isTeamChat = Boolean(roster.byId?.[sessionId] || roster.roomsById?.[sessionId])
  const isAgentChat = roster.agentOf?.[sessionId] !== undefined || (roster.ready === true && !isTeamChat)
  const chatInfo = chatOfSession(roster, sessionId)
  const chatId = chatInfo?.id ?? null
  const [text, setText] = useState(() => readSavedDraftText(chatId))
  const [caret, setCaret] = useState(0)
  const [attachments, setAttachments] = useState([])
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState(null)
  const [menuIndex, setMenuIndex] = useState(0)
  const [dismissedKey, setDismissedKey] = useState(null)
  const [referenceTrigger, setReferenceTrigger] = useState(null)
  const field = useRef(null)
  const fileInput = useRef(null)
  const seqRef = useRef(0)
  const hydratedChatRef = useRef(null)
  const skipNextSaveRef = useRef(false)
  const ownedUrlsRef = useRef(undefined)
  if (ownedUrlsRef.current === undefined) ownedUrlsRef.current = new Set()
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  const attachmentsRef = useRef(undefined)
  attachmentsRef.current = attachments
  const textRef = useRef(text)
  textRef.current = text
  const inputActions = useInput(field, textRef, setText, setCaret)
  const enterToSend = sendsOnEnter(roster.prefs)
  const rescued = useRescuedDrafts?.(state => readRescuedForChat(state, chatId, sessionId)) ?? ''

  useLayoutEffect(() => {
    const node = field.current
    node.style.height = 'auto'
    node.style.height = `${node.scrollHeight}px`
  }, [text])
  useEffect(() => { if (!disabled) field.current?.focus() }, [sessionId, disabled])
  useEffect(() => { if (!running) setStopping(false) }, [running, sessionId])
  useEffect(() => {
    const owned = ownedUrlsRef.current
    return () => {
      for (const url of owned) revokeUrl(url)
      owned.clear()
    }
  }, [])

  const buildAttachmentEntries = useCallback((rawList, extraMeta = null) => {
    const next = []
    let usedCost = (attachmentsRef.current ?? []).reduce((sum, item) => sum + stagedByteCost(item.size, item.isImage), 0)
    let oversized = false
    let overBudget = false
    for (const entry of rawList) {
      const file = entry?.file ?? entry
      if (!file) continue
      const size = Number.isFinite(file.size) ? file.size : 0
      if (size > MAX_ATTACHMENT_BYTES) {
        oversized = true
        continue
      }
      const mediaType = typeof file.type === 'string' ? file.type : ''
      const isImage = STAGED_IMAGE_TYPES.has(mediaType)
      const cost = stagedByteCost(size, isImage)
      if (usedCost + cost > MAX_BATCH_STAGED_BYTES) {
        overBudget = true
        continue
      }
      usedCost += cost
      const previewUrl = isImage && typeof URL?.createObjectURL === 'function' ? URL.createObjectURL(file) : null
      if (previewUrl) ownedUrlsRef.current.add(previewUrl)
      seqRef.current += 1
      const pastedText = extraMeta?.pastedText ?? entry?.pastedText
      next.push({
        id: `att-${seqRef.current}`,
        file,
        name: file.name || (isImage ? `image-${seqRef.current}.${mediaType.split('/')[1] || 'png'}` : `file-${seqRef.current}`),
        size,
        mediaType,
        isImage,
        previewUrl,
        ...(pastedText ? { pastedText } : {}),
      })
    }
    return { next, oversized, overBudget }
  }, [])

  // Restore saved draft text and in-memory files once per chat when the roster knows chatId.
  useEffect(() => {
    if (!chatId || hydratedChatRef.current === chatId) return
    const switching = hydratedChatRef.current !== null
    hydratedChatRef.current = chatId
    const savedText = readSavedDraftText(chatId)
    if (switching) {
      for (const item of attachmentsRef.current ?? []) {
        if (item.previewUrl) {
          ownedUrlsRef.current.delete(item.previewUrl)
          revokeUrl(item.previewUrl)
        }
      }
      attachmentsRef.current = []
      textRef.current = savedText
      skipNextSaveRef.current = true
      setReferenceTrigger(null)
      setDismissedKey(null)
      setError(null)
      setText(savedText)
      setCaret(savedText.length)
      const taken = takeDraft({ chatId, part: sessionId, text: savedText, attached: 0 })
      const { next } = taken.files.length > 0 ? buildAttachmentEntries(taken.files) : { next: [] }
      attachmentsRef.current = next
      setAttachments(next)
      return
    }
    if (savedText !== '' && textRef.current === '') {
      skipNextSaveRef.current = true
      textRef.current = savedText
      setText(savedText)
      setCaret(savedText.length)
    }
    const taken = takeDraft({ chatId, part: sessionId, text: textRef.current, attached: attachmentsRef.current.length })
    if (taken.files.length > 0) {
      const { next } = buildAttachmentEntries(taken.files)
      if (next.length > 0) {
        skipNextSaveRef.current = true
        setAttachments(current => (current.length === 0 ? next : current))
      }
    }
  }, [chatId, sessionId, buildAttachmentEntries])

  // Land rescued unsubmitted text from an externally cancelled/superseded question card into
  // the composer draft and persist it before clearing the rescue queue.
  useEffect(() => {
    if (disabled || !chatId || hydratedChatRef.current !== chatId || rescued === '') return
    const base = textRef.current
    const merged = mergeRescuedDraft(base, rescued)
    if (merged !== base) {
      textRef.current = merged
      skipNextSaveRef.current = true
      writeDraft({
        chatId,
        part: sessionId,
        text: merged,
        files: (attachmentsRef.current ?? []).map(item => ({
          kind: item.isImage ? 'image' : 'file',
          file: item.file,
          ...(item.pastedText ? { pastedText: item.pastedText } : {}),
        })),
      })
      setText(merged)
      setCaret(merged.length)
    }
    actions?.consumeRescuedDraft?.(chatId, sessionId, rescued)
  }, [chatId, sessionId, rescued, disabled, actions])

  // Keep unsent draft text (localStorage) & files (in-memory) synced across chat switches and rollovers.
  useEffect(() => {
    if (!chatId || hydratedChatRef.current !== chatId) return
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false
      return
    }
    writeDraft({
      chatId,
      part: sessionId,
      text,
      files: attachments.map(item => ({
        kind: item.isImage ? 'image' : 'file',
        file: item.file,
        ...(item.pastedText ? { pastedText: item.pastedText } : {}),
      })),
    })
  }, [chatId, sessionId, text, attachments])

  // Open the chat-reference `@` picker when "+ → Reference a chat" is clicked.
  useEffect(() => {
    if (!feed) return undefined
    return feed.on((event, data) => {
      if (event !== 'reference-chat' || data?.sessionId !== sessionId) return
      const currentLen = textRef.current.length
      const start = Math.max(0, Math.min(data.insertion?.start ?? currentLen, currentLen))
      const end = Math.max(start, Math.min(data.insertion?.end ?? start, currentLen))
      setReferenceTrigger({ start, end })
      setDismissedKey(null)
      setMenuIndex(0)
      field.current?.focus?.()
    })
  }, [feed, sessionId])

  const addFiles = useCallback((fileList, extraMeta = null) => {
    if (disabled) return
    const list = Array.from(fileList ?? []).filter(Boolean)
    if (list.length === 0) return
    const { next, oversized, overBudget } = buildAttachmentEntries(list, extraMeta)
    if (oversized) setError(t('File too large (max {size})', { size: '16 MB' }))
    else if (overBudget) setError(t('File too large (max {size})', { size: '64 MB' }))
    else if (next.length > 0) setError(null)
    if (next.length > 0) setAttachments(current => [...current, ...next])
  }, [disabled, buildAttachmentEntries])

  if (addFilesRef) addFilesRef.current = addFiles

  const removeAttachment = useCallback((id) => {
    const current = attachmentsRef.current ?? []
    const target = current.find(item => item.id === id)
    if (target?.previewUrl) {
      ownedUrlsRef.current.delete(target.previewUrl)
      revokeUrl(target.previewUrl)
    }
    const next = current.filter(item => item.id !== id)
    attachmentsRef.current = next
    if (chatId && hydratedChatRef.current === chatId) {
      writeDraft({
        chatId,
        part: sessionId,
        text: textRef.current,
        files: next.map(item => ({
          kind: item.isImage ? 'image' : 'file',
          file: item.file,
          ...(item.pastedText ? { pastedText: item.pastedText } : {}),
        })),
      })
    }
    setAttachments(next)
  }, [chatId, sessionId])

  const putBackPaste = useCallback((item) => {
    if (!item?.pastedText) return
    inputActions.insertText(item.pastedText, inputActions.captureInsertion())
    removeAttachment(item.id)
  }, [inputActions, removeAttachment])

  const onFilePick = (event) => {
    addFiles(event.target?.files)
    if (event.target) event.target.value = ''
  }

  const onPaste = (event) => {
    if (disabled) return
    const files = filesFromClipboard(event.clipboardData)
    if (files.length > 0) {
      addFiles(files)
      const plain = typeof event.clipboardData?.getData === 'function' ? event.clipboardData.getData('text/plain') : ''
      if (!plain) event.preventDefault()
      return
    }
    const plain = typeof event.clipboardData?.getData === 'function' ? event.clipboardData.getData('text/plain') : ''
    const kept = foldPastedText(plain)
    if (kept !== null && typeof File === 'function') {
      event.preventDefault()
      const file = new File([kept], pastedName(kept), { type: 'text/plain' })
      addFiles([file], { pastedText: kept })
    }
  }

  // Composer trigger menus: "+ → Reference a chat", "@mention", and "/command".
  const rawTrigger = disabled ? null : (referenceTrigger
    ? { kind: 'reference', start: referenceTrigger.start, end: referenceTrigger.end, query: '' }
    : activeComposerTrigger(text, caret))
  const triggerKey = rawTrigger ? `${rawTrigger.kind}:${rawTrigger.start}:${rawTrigger.query}` : null
  const trigger = rawTrigger && dismissedKey !== triggerKey ? rawTrigger : null
  const menuItems = useMemo(() => (trigger
    ? buildComposerMenuItems({ mode: trigger.kind, query: trigger.query, roster, sessions, sessionId, actions })
    : []), [trigger, roster, sessions, sessionId, actions])
  const clampedMenuIndex = menuItems.length > 0 ? Math.max(0, Math.min(menuIndex, menuItems.length - 1)) : 0
  useEffect(() => { setMenuIndex(0) }, [triggerKey])

  const closeMenu = () => {
    if (referenceTrigger) setReferenceTrigger(null)
    else if (triggerKey) setDismissedKey(triggerKey)
  }

  const selectMenuItem = (item) => {
    if (!item || !trigger) return
    setReferenceTrigger(null)
    setDismissedKey(null)
    if (item.kind === 'insert') {
      const { text: nextText, caret: nextCaret } = applyTriggerText(text, trigger, item.insertText)
      textRef.current = nextText
      setText(nextText)
      setCaret(nextCaret)
      const focusCaret = () => {
        field.current?.focus?.()
        field.current?.setSelectionRange?.(nextCaret, nextCaret)
      }
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focusCaret)
      else focusCaret()
      return
    }
    const { text: nextText, caret: nextCaret } = applyTriggerText(text, trigger, '')
    textRef.current = nextText
    setText(nextText)
    setCaret(nextCaret)
    item.run?.()
  }

  const canSend = !disabled && (text.trim() !== '' || attachments.length > 0)
  const submit = async () => {
    const value = text.trim()
    const items = attachments.slice()
    if ((value === '' && items.length === 0) || disabled) return
    setError(null)
    setReferenceTrigger(null)
    setDismissedKey(null)
    textRef.current = ''
    attachmentsRef.current = []
    setText('')
    setCaret(0)
    setAttachments([])
    const clearedRev = chatId ? writeDraft({ chatId, part: sessionId, text: '', files: [] }) : null
    try {
      await onSend(value, items)
      // Hand previewUrl cleanup to Chat's pending-message lifecycle on success.
      for (const item of items) {
        if (item.previewUrl) ownedUrlsRef.current.delete(item.previewUrl)
      }
    } catch (failure) {
      if (!mountedRef.current) {
        if (chatId && draftRevisions.get(chatId) === clearedRev) {
          writeDraft({
            chatId,
            part: sessionId,
            text: value,
            files: items.map(item => ({
              kind: item.isImage ? 'image' : 'file',
              file: item.file,
              ...(item.pastedText ? { pastedText: item.pastedText } : {}),
            })),
          })
        }
        return
      }
      setText((current) => {
        const next = current === '' ? value : current
        textRef.current = next
        return next
      })
      if (items.length > 0) {
        setAttachments((current) => {
          const next = [...items, ...current]
          attachmentsRef.current = next
          return next
        })
      }
      setError(failure?.message ?? String(failure))
    }
  }

  const stop = async () => {
    if (!running || stopping || typeof onStop !== 'function') return
    setError(null)
    setStopping(true)
    try {
      await onStop()
    } catch (failure) {
      setError(failure?.message ?? String(failure))
    } finally {
      setStopping(false)
    }
  }

  const syncCaret = (event) => {
    const pos = event?.target?.selectionStart
    if (typeof pos === 'number') setCaret(pos)
  }

  const menuLabel = trigger?.kind === 'command' ? t('Commands')
    : trigger?.kind === 'reference' ? t('Reference a chat')
      : t('Mention a Bot')

  return h('div', { className: 'dsb-composer-wrap' },
    error ? h('p', { className: 'dsb-composer-error', role: 'alert' }, error) : null,
    menuItems.length > 0 ? h(ComposerMenu, {
      items: menuItems,
      activeIndex: clampedMenuIndex,
      label: menuLabel,
      onHover: setMenuIndex,
      onSelect: selectMenuItem,
    }) : null,
    h('div', {
      className: 'dsb-composer',
      'data-composer-card': '',
      'data-multiline': (text.includes('\n') || attachments.length > 0) || undefined,
      'data-running': (running && typeof onStop === 'function') || undefined,
    },
    h('input', { ref: fileInput, type: 'file', multiple: true, hidden: true, disabled, tabIndex: -1, onChange: onFilePick }),
    h(ComposerAttachments, { items: attachments, onRemove: removeAttachment, onPutBackPaste: putBackPaste }),
    h('div', { className: 'dsb-composer-tools' },
      isAgentChat
        ? h(AgentComposerPlus, { disabled, fileInput, actions })
        : h(ComposerPlus, { sessionId, inputActions, useRoster, useWork, actions })),
    h('div', { className: 'dsb-composer-input', 'data-input-scroll': '' },
      h('textarea', {
        ref: field,
        rows: 1,
        value: text,
        disabled,
        placeholder,
        'aria-label': placeholder,
        'data-composer-input': '',
        onChange: (event) => {
          setText(event.target.value)
          setReferenceTrigger(null)
          setDismissedKey(null)
          const pos = event.target?.selectionStart
          setCaret(typeof pos === 'number' ? pos : event.target.value.length)
        },
        onClick: syncCaret,
        onKeyUp: syncCaret,
        onSelect: syncCaret,
        onBlur: closeMenu,
        onPaste,
        onKeyDown: (event) => {
          if (menuItems.length > 0 && !isImeComposing(event)) {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setMenuIndex((clampedMenuIndex + 1) % menuItems.length)
              return
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              setMenuIndex((clampedMenuIndex - 1 + menuItems.length) % menuItems.length)
              return
            }
            if (((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') && !event.altKey && !event.ctrlKey && !event.metaKey) {
              event.preventDefault()
              selectMenuItem(menuItems[clampedMenuIndex])
              return
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              closeMenu()
              return
            }
          }
          const plainEnter = event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey
          const modEnter = event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey
          if ((enterToSend ? (plainEnter || modEnter) : modEnter) && !isImeComposing(event)) {
            event.preventDefault()
            void submit()
          }
        },
      })),
    h('div', { className: 'dsb-composer-trailing' },
      isAgentChat ? null : h(ComposerVoice, { sessionId, inputActions, actions, useUi, useRoster }),
      running && typeof onStop === 'function' ? h('button', {
        type: 'button',
        className: 'dsb-stop',
        disabled: stopping,
        'aria-busy': stopping || undefined,
        'aria-label': t('Stop generating'),
        title: t('Stop generating'),
        onClick: () => { void stop() },
      }, h(StopIcon)) : null,
      h('button', {
        type: 'button',
        className: 'dsb-send',
        disabled: !canSend,
        'aria-label': t('Send message'),
        title: t('Send message'),
        onClick: () => { void submit() },
      }, h(ArrowUpIcon)))))
}

function PendingUserRows({ items, sessionId, classic = false }) {
  if (!items || items.length === 0) return null
  if (classic) {
    return h('div', { className: 'dsb-pending' }, items.map((entry, index) => h('div', { key: `${entry.time}:${index}`, className: 'dsb-dsh-user' },
      h('div', { className: 'dsb-dsh-user-stack' },
        entry.attachments?.length ? h(UserAttachments, { attachments: entry.attachments, sessionId }) : null,
        entry.text !== '' ? h('div', { className: 'dsb-dsh-user-bubble' }, entry.text) : null))))
  }
  return h('div', { className: 'dsb-pending' }, items.map((entry, index) => h('div', { key: `${entry.time}:${index}`, className: 'bt-umsg' },
    h('div', { className: 'bt-ustack' },
      entry.attachments?.length ? h(UserAttachments, { attachments: entry.attachments, sessionId }) : null,
      entry.text !== '' ? h('div', { className: 'bt-ubody' }, entry.text) : null))))
}

// One conversation in the main view, drawn with the Bot views' own rows, cards and docks.
// DM current segments follow DSH's session log via `api/bot/session` + `session-log.js`;
// group chats continue to read `room-chat`.
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
  const useSessions = hooks.useSessions ?? NO_SESSIONS_HOOK
  const sessionBlank = useSessions(list => list.byId[activeSessionId]?.blank === true)

  const [pending, setPending] = useState([])
  const [dragging, setDragging] = useState(false)
  const sendGen = useRef(0)
  const dragDepth = useRef(0)
  const addFilesRef = useRef(undefined)
  const pendingRef = useRef(undefined)
  pendingRef.current = pending
  const scroller = useRef(null)
  const follow = useRef(true)
  const keep = useRef(null)

  useEffect(() => {
    sendGen.current += 1
    keep.current = null
    follow.current = true
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
  const sessionRunning = hooks.useSessionStatus(map => map.get(activeSessionId)?.running === true)
  const running = sessionRunning || (!isRoom && dmChat.log.writing !== null)

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
  const send = async (text, items = []) => {
    follow.current = true
    const myGen = sendGen.current
    const pendingAttachments = items.map(item => (item.isImage
      ? { type: 'image', attachment: { name: item.name, previewUrl: item.previewUrl } }
      : { type: 'file', attachment: { name: item.name, bytes: item.size } }))
    const imageCount = items.filter(item => item.isImage).length
    const fileCount = items.length - imageCount
    const entry = {
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
    actions.noteSent(activeSessionId)
    try {
      const batchCost = items.reduce((sum, item) => sum + stagedByteCost(item.size, item.isImage), 0)
      if (batchCost > MAX_BATCH_STAGED_BYTES) {
        throw new Error(t('File too large (max {size})', { size: '64 MB' }))
      }
      const imageIds = []
      const fileIds = []
      for (const item of items) {
        const base64 = await fileToBase64(item.file)
        if (item.isImage) {
          const staged = await (typeof actions.stageImage === 'function'
            ? actions.stageImage(item.mediaType, base64, item.name)
            : call('stage-image', { mediaType: item.mediaType, data: base64, name: item.name }))
          imageIds.push(staged.id)
        } else {
          const staged = await (typeof actions.stageFile === 'function'
            ? actions.stageFile(item.name, base64, item.mediaType)
            : call('stage-file', { name: item.name, data: base64, mediaType: item.mediaType }))
          fileIds.push(staged.id)
        }
      }
      if (imageIds.length > 0 || fileIds.length > 0) {
        await actions.send(activeSessionId, text, { images: imageIds, files: fileIds })
      } else {
        await actions.send(activeSessionId, text)
      }
      // Ownership of previewUrls transfers here: if pending already cleared (e.g. fast SSE or
      // rollover before React committed a re-render), revoke immediately via `entry.removed`.
      entry.settled = true
      if (entry.removed) revokeEntryUrls(entry)
    } catch (error) {
      if (sendGen.current === myGen) {
        entry.removed = true
        setPending(list => list.filter(item => item !== entry))
      }
      throw error
    }
  }

  const readOnly = Boolean(roster.readOnly)
  const onStop = readOnly ? undefined
    : isRoom
      ? (typeof actions.stopRoomWork === 'function' && room?.id ? () => actions.stopRoomWork(room.id) : undefined)
      : bot?.id && typeof actions.stopChat === 'function'
        ? () => actions.stopChat(bot.id)
        : (agentId && typeof actions.stopAgent === 'function' ? () => actions.stopAgent(agentId, activeSessionId) : undefined)

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
  const locked = waiting || readOnly
  const useWork = hooks.useWork ?? NO_WORK_HOOK
  const useCards = hooks.useCards ?? NO_OBJ_HOOK
  const useHeldCards = hooks.useHeldCards ?? NO_OBJ_HOOK
  const useComputer = hooks.useComputer ?? NO_OBJ_HOOK
  const useBrowserHolds = hooks.useBrowserHolds ?? NO_OBJ_HOOK
  const useBrowserTabs = hooks.useBrowserTabs ?? NO_OBJ_HOOK
  const useBrowserPages = hooks.useBrowserPages ?? NO_OBJ_HOOK

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

  const renderRoomUserAttachments = useCallback((row) => {
    const blocks = [
      ...(Array.isArray(row.imageRefs) ? row.imageRefs.map(ref => ({ type: 'image', attachment: ref })) : []),
      ...(Array.isArray(row.fileRefs) ? row.fileRefs.map(ref => ({ type: 'file', attachment: ref })) : []),
    ]
    if (blocks.length === 0) return null
    return h(UserAttachments, { attachments: blocks, sessionId: row.sessionId ?? activeSessionId })
  }, [activeSessionId])

  const hasAgentMessages = !isRoom && Array.isArray(dmChat.log?.events)
    && dmChat.log.events.some(ev => ev?.type === 'user/message' || ev?.type === 'assistant/message' || ev?.type === 'turn/start' || ev?.type === 'tool/call')
  const showAgentHero = isAgent
    && (!dmChat.loading || sessionBlank)
    && !dmChat.failed
    && !dmChat.terminalError
    && !dmChat.hasMore
    && pending.length === 0
    && dmChat.log.writing === null
    && !hasAgentMessages
  const heroCwd = dmChat.log?.header?.cwd || roster.workspace || ''

  return h('div', {
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
  h('div', { ref: scroller, className: 'dsb-scroll', 'data-conversation-scroll': '', 'data-empty-hero': showAgentHero ? '' : undefined, onScroll },
    showAgentHero ? h(AgentEmptyHero, { cwd: heroCwd, actions, readOnly }) : null,
    h('div', { className: 'dsb-column' },
      earlier ? h('div', { className: 'bt-earlier-top' }, earlier) : null,
      sessionNotice,
      h('div', { className: 'dsb-flow', 'data-chat-flow': '', role: 'feed', 'aria-label': name, 'aria-busy': busy },
        isRoom
          ? h(MemoChatRows, { items: roomChat.view.items, sessionId, roster, actions, useUi: hooks.useUi, clock: true, renderUserAttachments: renderRoomUserAttachments })
          : h(SessionTranscript, {
            log: dmChat.log,
            sessionId: activeSessionId,
            bot,
            roster,
            actions,
            classic: isClassic,
            useUi: hooks.useUi,
            useRoster: hooks.useRoster,
            useWork,
            useTurnClock: hooks.useTurnClock,
            useHeldCards,
            useBrowserHolds,
            useBrowserTabs,
            useBrowserPages,
            useComputer,
            thinkingAt: dmChat.thinkingAt,
            hasMore: dmChat.hasMore,
            registry,
          }),
        h(PendingUserRows, { items: pending, sessionId: activeSessionId, classic: isClassic }),
        // The Bot views' activity row (from the header pill) draws itself in here.
        h('div', { 'data-chat-running': '' })))),
  h('div', { className: 'dsb-composer-root' },
    h(MemberDock, { sessionId: activeSessionId, useRoster: hooks.useRoster, useWork, useComputer, actions }),
    h(ModelChoiceDock, { sessionId: activeSessionId, useRoster: hooks.useRoster, actions }),
    h(QuestionDock, { sessionId: activeSessionId, useRoster: hooks.useRoster, useCards, useHeldCards, actions }),
    !isRoom ? h(WidgetDock, { sessionId: activeSessionId, useRoster: hooks.useRoster, useCards, useHeldCards, actions }) : null,
    !isRoom ? h(SecretDock, { sessionId: activeSessionId, useRoster: hooks.useRoster, useCards, useHeldCards, actions }) : null,
    !isRoom ? h(ConnectorDock, { sessionId: activeSessionId, useRoster: hooks.useRoster, useCards, useHeldCards, actions }) : null,
    !isRoom ? h(MailDock, { sessionId: activeSessionId, useRoster: hooks.useRoster, useCards, useHeldCards, actions }) : null,
    !isRoom ? h(HandoffDock, { sessionId: activeSessionId, useRoster: hooks.useRoster, useCards, useHeldCards, useBrowserHolds, useBrowserTabs, useBrowserPages, actions }) : null,
    !isRoom ? h(ComputerHandoffDock, { sessionId: activeSessionId, useRoster: hooks.useRoster, useCards, useHeldCards, useComputer, actions }) : null,
    !isRoom ? h(AppAccessDock, { sessionId: activeSessionId, useRoster: hooks.useRoster, useCards, useHeldCards, useComputer, actions }) : null,
    !isRoom ? h(ApprovalDock, { botId: bot?.id, sessionId: activeSessionId, useWork, actions, readOnly }) : null,
    !isRoom && typeof actions.turnFacts === 'function' && typeof actions.watchTurns === 'function' ? h(BtwDock, { sessionId: activeSessionId, useRoster: hooks.useRoster, actions }) : null,
    !isRoom && typeof actions.turnFacts === 'function' && typeof actions.watchTurns === 'function' ? h(LearningDock, { sessionId: activeSessionId, useRoster: hooks.useRoster, actions }) : null,
    h(Composer, {
      sessionId: activeSessionId,
      disabled: locked,
      running,
      placeholder: waiting ? t('Pick a model and {name} can start.', { name }) : name ? t('Message {name}', { name }) : t('Message'),
      onSend: send,
      onStop,
      addFilesRef,
      actions,
      feed,
      useUi: hooks.useUi,
      useRoster: hooks.useRoster,
      useWork,
      useSessions: hooks.useSessions,
      useRescuedDrafts: hooks.useRescuedDrafts,
    })))
}
