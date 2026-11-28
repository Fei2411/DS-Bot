import { createElement as h, Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { call } from '../../../ds-bot/src/client/api.js'
import { BtwDock } from '../../../ds-bot/src/client/btw.js'
import { ComposerPlus, ComposerVoice } from '../../../ds-bot/src/client/composer.js'
import { AppAccessDock, ComputerHandoffDock } from '../../../ds-bot/src/client/computer.js'
import { ConnectorDock, MailDock } from '../../../ds-bot/src/client/connectors.js'
import { chatOfSession, keepDraft, keepDraftText, takeDraft } from '../../../ds-bot/src/client/draft-keep.js'
import { fileExtension, fileSizeText } from '../../../ds-bot/src/client/dsh-primitives.js'
import { isImeComposing, sendsOnEnter } from '../../../ds-bot/src/client/enter-key.js'
import { HandoffDock } from '../../../ds-bot/src/client/handoff-card.js'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { ArrowUpIcon, CloseIcon, FileIcon, FolderIcon, PaperclipIcon, PlusIcon, StopIcon, TerminalIcon } from '../../../ds-bot/src/client/icons.js'
import { LearningDock } from '../../../ds-bot/src/client/learning-card.js'
import { MemberDock } from '../../../ds-bot/src/client/member-status.js'
import { ModelChoiceDock } from '../../../ds-bot/src/client/model-menu.js'
import { stepMenuFocus, useLinger, useViewport, viewBottom } from '../../../ds-bot/src/client/motion.js'
import { hasEscapeLayer } from '../../../ds-bot/src/client/overlay-hooks.js'
import { PasteCard, foldPastedText, pastedName } from '../../../ds-bot/src/client/paste-card.js'
import { mergeRescuedDraft, readRescuedForChat } from '../../../ds-bot/src/client/question-draft.js'
import { QuestionDock } from '../../../ds-bot/src/client/questions.js'
import { SecretDock } from '../../../ds-bot/src/client/secret-card.js'
import { STORAGE } from '../../../ds-bot/src/client/storage.js'
import { quoteMarkdown } from '../../../ds-bot/src/client/text-annotation.js'
import { WidgetDock } from '../../../ds-bot/src/client/widget-cell.js'
import { WorkPauseDock } from '../../../ds-bot/src/client/work-pause-card.js'
import { ApprovalDock } from './approval-dock.js'
import { ClassicControls } from './classic-controls.js'
import { ClassicPlanReviewDock, ClassicQuestionDock } from './classic-questions.js'
import { ComposerMenu, activeComposerTrigger, applyTriggerText, buildComposerMenuItems } from './composer-menus.js'
import {
  FailedSendBar,
  clearFailedSends,
  heldFailedUrls,
  inFlightUrls,
  pendingFailedByChat,
  pruneFailedSends,
  revokeUrl,
  trackFailedUrls,
  trackInFlightUrls,
} from './failed-send-bar.js'
import { DesktopQueueDock } from './queue-dock.js'
import { SubagentReadOnlyBar } from './subagent-viewer.js'

const STAGED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024
// Matches host STAGED_TOTAL_MAX (64 MB) using the same accounting (base64 length for images, raw bytes for files).
const MAX_BATCH_STAGED_BYTES = 64 * 1024 * 1024
const stagedByteCost = (size, isImage) => (isImage ? Math.ceil(size / 3) * 4 : size)
const EMPTY_OBJ = {}
const EMPTY_LIST = Object.freeze([])
const EMPTY_WORK = { bots: {}, approvals: [] }
const EMPTY_SESSIONS = { ids: [], byId: {} }
const NO_OBJ_HOOK = selector => selector(EMPTY_OBJ)
const NO_LIST_HOOK = selector => selector(EMPTY_LIST)
const NO_WORK_HOOK = selector => selector(EMPTY_WORK)
const NO_SESSIONS_HOOK = selector => selector(EMPTY_SESSIONS)

const MemoMemberDock = memo(MemberDock)
const MemoModelChoiceDock = memo(ModelChoiceDock)
const MemoQuestionDock = memo(QuestionDock)
const MemoWidgetDock = memo(WidgetDock)
const MemoSecretDock = memo(SecretDock)
const MemoConnectorDock = memo(ConnectorDock)
const MemoMailDock = memo(MailDock)
const MemoWorkPauseDock = memo(WorkPauseDock)
const MemoHandoffDock = memo(HandoffDock)
const MemoComputerHandoffDock = memo(ComputerHandoffDock)
const MemoAppAccessDock = memo(AppAccessDock)
const MemoApprovalDock = memo(ApprovalDock)
const MemoClassicPlanReviewDock = memo(ClassicPlanReviewDock)
const MemoClassicQuestionDock = memo(ClassicQuestionDock)
const MemoBtwDock = memo(BtwDock)
const MemoLearningDock = memo(LearningDock)
const MemoDesktopQueueDock = memo(DesktopQueueDock)
const MemoSubagentReadOnlyBar = memo(SubagentReadOnlyBar)

export { clearFailedSends, pruneFailedSends }

let failedSendSeq = 0
const liveWithdrawByChat = new Map()
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

export function withdrawQueuedText({ chatId, chatKey, sessionId, text }) {
  const incoming = String(text ?? '').trim()
  if (incoming === '') return
  const live = liveWithdrawByChat.get(chatKey)
  if (typeof live === 'function') {
    live(incoming)
    return
  }
  if (!chatId) return
  const merged = mergeRescuedDraft(readSavedDraftText(chatId), incoming)
  draftRevisions.set(chatId, (draftRevisions.get(chatId) ?? 0) + 1)
  keepDraftText({ chatId, part: sessionId, text: merged })
}

export async function stageAttachmentItems(items, actions) {
  if (!Array.isArray(items) || items.length === 0) return { images: [], files: [] }
  const batchCost = items.reduce((sum, item) => sum + stagedByteCost(item.size, item.isImage), 0)
  if (batchCost > MAX_BATCH_STAGED_BYTES) {
    throw new Error(t('File too large (max {size})', { size: '64 MB' }))
  }
  const images = []
  const files = []
  for (const item of items) {
    const base64 = await fileToBase64(item.file)
    if (item.isImage) {
      const staged = await (typeof actions?.stageImage === 'function'
        ? actions.stageImage(item.mediaType, base64, item.name)
        : call('stage-image', { mediaType: item.mediaType, data: base64, name: item.name }))
      images.push(staged.id)
    } else {
      const staged = await (typeof actions?.stageFile === 'function'
        ? actions.stageFile(item.name, base64, item.mediaType)
        : call('stage-file', { name: item.name, data: base64, mediaType: item.mediaType }))
      files.push(staged.id)
    }
  }
  return { images, files }
}

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
      reader.onerror = () => reject(reader.error ?? new Error(t('Failed to read file')))
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

// What the Bot views' voice/quote/paste helpers ask of a composer:
// where the caret is, text insertion at caret, and focusing the textarea.
function useInput(field, textRef, setText, setCaret, onEdit) {
  return useMemo(() => ({
    captureInsertion: () => (field.current ? { start: field.current.selectionStart, end: field.current.selectionEnd } : null),
    insertText: (value, at) => {
      const current = textRef.current ?? ''
      const start = Math.max(0, Math.min(at?.start ?? current.length, current.length))
      const end = Math.max(start, Math.min(at?.end ?? start, current.length))
      const nextText = current.slice(0, start) + value + current.slice(end)
      const nextCaret = start + value.length
      onEdit?.()
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
  }), [field, textRef, setText, setCaret, onEdit])
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
    const cardTop = buttonRef.current.closest?.('[data-bt-composer]')?.getBoundingClientRect?.().top
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

export const Composer = memo(function Composer({ sessionId, placeholder, disabled, running, onSend, onStop, addFilesRef, withdrawRef, insertQuoteRef, actions, feed, useUi, useRoster, useWork, useSessions, useSessionQueues, useRescuedDrafts }) {
  const roster = useRoster(value => value)
  const sessions = (useSessions ?? NO_SESSIONS_HOOK)(value => value)
  const sessionQueue = (useSessionQueues ?? NO_OBJ_HOOK)(map => map?.[sessionId] ?? EMPTY_LIST)
  const isTeamChat = Boolean(roster.byId?.[sessionId] || roster.roomsById?.[sessionId])
  const isAgentChat = roster.agentOf?.[sessionId] !== undefined || (roster.ready === true && !isTeamChat)
  const chatInfo = chatOfSession(roster, sessionId)
  const chatId = chatInfo?.id ?? null
  const chatKey = chatId ?? sessionId
  const [text, setText] = useState(() => readSavedDraftText(chatId))
  const [caret, setCaret] = useState(0)
  const [attachments, setAttachments] = useState([])
  const [failedSends, setFailedSends] = useState(() => pendingFailedByChat.get(chatKey) ?? [])
  const [retryingFailedId, setRetryingFailedId] = useState(null)
  const [classicControls, setClassicControls] = useState(null)
  const [classicCommands, setClassicCommands] = useState(EMPTY_LIST)
  const [classicSkills, setClassicSkills] = useState(EMPTY_LIST)
  const [classicFiles, setClassicFiles] = useState(EMPTY_LIST)
  const [stopping, setStopping] = useState(false)
  const lastEscAt = useRef(0)
  useEffect(() => { lastEscAt.current = 0 }, [sessionId, running])
  const [error, setError] = useState(null)
  const [commandNotice, setCommandNotice] = useState(null)
  const classicControlsRef = useRef(classicControls)
  classicControlsRef.current = classicControls
  useEffect(() => {
    if (!commandNotice) return undefined
    const timer = setTimeout(() => setCommandNotice(null), 4500)
    return () => clearTimeout(timer)
  }, [commandNotice])
  const [menuIndex, setMenuIndex] = useState(0)
  const [dismissedKey, setDismissedKey] = useState(null)
  const [referenceTrigger, setReferenceTrigger] = useState(null)
  const field = useRef(null)
  const fileInput = useRef(null)
  const seqRef = useRef(0)
  const fileQuerySeq = useRef(0)
  const draftEditSeqRef = useRef(0)
  const steeringRef = useRef(false)
  const classicCommandsRef = useRef(EMPTY_LIST)
  const commandsLoadedForRef = useRef(null)
  const commandsPromiseRef = useRef(null)
  const skillsLoadedForRef = useRef(null)
  const skillsPromiseRef = useRef(null)
  const hydratedChatRef = useRef(null)
  const skipNextSaveRef = useRef(false)
  const ownedUrlsRef = useRef(undefined)
  if (ownedUrlsRef.current === undefined) ownedUrlsRef.current = new Set()
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  const chatKeyRef = useRef(chatKey)
  chatKeyRef.current = chatKey
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId
  const rosterRef = useRef(roster)
  rosterRef.current = roster
  const attachmentsRef = useRef(undefined)
  attachmentsRef.current = attachments
  const textRef = useRef(text)
  textRef.current = text
  const noteDraftEdit = useCallback(() => { draftEditSeqRef.current += 1 }, [])
  const inputActions = useInput(field, textRef, setText, setCaret, noteDraftEdit)
  useEffect(() => {
    if (!insertQuoteRef) return undefined
    insertQuoteRef.current = (raw) => {
      const quoted = quoteMarkdown(String(raw ?? ''))
      if (quoted === '') return false
      const existing = textRef.current ?? ''
      const prefix = existing === '' ? '' : existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n'
      return inputActions.insertText(`${prefix}${quoted}\n\n`, { start: existing.length, end: existing.length })
    }
    return () => { insertQuoteRef.current = undefined }
  }, [insertQuoteRef, inputActions])
  const enterToSend = sendsOnEnter(roster.prefs)
  const rescued = useRescuedDrafts?.(state => readRescuedForChat(state, chatId, sessionId)) ?? ''

  useEffect(() => {
    setFailedSends(pendingFailedByChat.get(chatKey) ?? [])
    setRetryingFailedId(null)
    setCommandNotice(null)
  }, [chatKey])

  // Load classic session controls (model, effort, permissions, plan state).
  // Slash commands & skills load lazily when `/` opens or is submitted so browsing cold
  // Classic sessions never wakes their Agent on Host.
  const refreshClassicControls = useCallback(() => {
    if (!isAgentChat || !sessionId || typeof actions?.sessionControls !== 'function') return
    void Promise.resolve(actions.sessionControls(sessionId))
      .then((value) => {
        if (mountedRef.current && chatKeyRef.current === chatKey && value) setClassicControls(value)
      })
      .catch(() => {})
  }, [isAgentChat, sessionId, chatKey, actions])

  const ensureClassicCommands = useCallback(async () => {
    if (!isAgentChat || !sessionId || typeof actions?.sessionCommands !== 'function') return EMPTY_LIST
    if (commandsLoadedForRef.current === sessionId) return classicCommandsRef.current
    if (commandsPromiseRef.current?.sessionId === sessionId) return commandsPromiseRef.current.promise
    const targetSession = sessionId
    const promise = Promise.resolve(actions.sessionCommands(targetSession, { wake: true }))
      .then((value) => {
        const list = Array.isArray(value?.commands) ? value.commands : EMPTY_LIST
        if (mountedRef.current && sessionIdRef.current === targetSession) {
          classicCommandsRef.current = list
          commandsLoadedForRef.current = targetSession
          setClassicCommands(list)
        }
        return list
      })
      .catch(() => EMPTY_LIST)
      .finally(() => {
        if (commandsPromiseRef.current?.promise === promise) commandsPromiseRef.current = null
      })
    commandsPromiseRef.current = { sessionId: targetSession, promise }
    return promise
  }, [isAgentChat, sessionId, actions])

  const ensureClassicSkills = useCallback(async () => {
    if (!isAgentChat || !sessionId || typeof actions?.sessionSkills !== 'function') return EMPTY_LIST
    if (skillsLoadedForRef.current === sessionId) return EMPTY_LIST
    if (skillsPromiseRef.current?.sessionId === sessionId) return skillsPromiseRef.current.promise
    const targetSession = sessionId
    const promise = Promise.resolve(actions.sessionSkills(targetSession))
      .then((value) => {
        const list = Array.isArray(value?.skills) ? value.skills : EMPTY_LIST
        if (mountedRef.current && sessionIdRef.current === targetSession) {
          skillsLoadedForRef.current = targetSession
          setClassicSkills(list)
        }
        return list
      })
      .catch(() => EMPTY_LIST)
      .finally(() => {
        if (skillsPromiseRef.current?.promise === promise) skillsPromiseRef.current = null
      })
    skillsPromiseRef.current = { sessionId: targetSession, promise }
    return promise
  }, [isAgentChat, sessionId, actions])

  const refreshClassicControlsRef = useRef(refreshClassicControls)
  refreshClassicControlsRef.current = refreshClassicControls
  const ensureClassicCommandsRef = useRef(ensureClassicCommands)
  ensureClassicCommandsRef.current = ensureClassicCommands
  const ensureClassicSkillsRef = useRef(ensureClassicSkills)
  ensureClassicSkillsRef.current = ensureClassicSkills

  useEffect(() => {
    classicCommandsRef.current = EMPTY_LIST
    commandsLoadedForRef.current = null
    commandsPromiseRef.current = null
    skillsLoadedForRef.current = null
    skillsPromiseRef.current = null
    setClassicCommands(EMPTY_LIST)
    setClassicSkills(EMPTY_LIST)
    setClassicFiles(EMPTY_LIST)
    if (!isAgentChat || !sessionId) {
      setClassicControls(null)
      return undefined
    }
    refreshClassicControlsRef.current()
    const offFeed = feed?.on?.((event, data) => {
      if (event === 'live' || event === 'revision' || (event === 'hello' && data?.resumed !== true)) refreshClassicControlsRef.current()
    })
    return () => { offFeed?.() }
  }, [isAgentChat, sessionId, feed])

  useLayoutEffect(() => {
    const node = field.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${node.scrollHeight}px`
  }, [text])
  const mountedFocusRef = useRef(false)
  useEffect(() => {
    const isMount = !mountedFocusRef.current
    mountedFocusRef.current = true
    if (disabled) return
    if (typeof document !== 'undefined') {
      if (document.querySelector?.('[aria-modal="true"]')) return
      const activeEl = document.activeElement
      if (activeEl && activeEl !== document.body && activeEl !== document.documentElement && activeEl !== field.current
        && typeof activeEl.closest === 'function') {
        const activeTerm = activeEl.closest('.dsb-term')
        const staleOtherTerm = isMount && activeTerm && sessionId
          && activeTerm.getAttribute?.('data-session-id')
          && activeTerm.getAttribute('data-session-id') !== sessionId
        if (!staleOtherTerm && activeEl.closest('.dsb-term, textarea, input, select, [contenteditable="true"], [role="dialog"], [role="menu"]')) {
          return
        }
      }
    }
    field.current?.focus?.()
  }, [chatKey, sessionId, disabled])
  useEffect(() => { if (!running) setStopping(false) }, [running, sessionId])
  useEffect(() => {
    const owned = ownedUrlsRef.current
    return () => {
      for (const url of owned) {
        if (!heldFailedUrls.has(url) && !inFlightUrls.has(url)) revokeUrl(url)
      }
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
          if (!heldFailedUrls.has(item.previewUrl) && !inFlightUrls.has(item.previewUrl)) revokeUrl(item.previewUrl)
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
    if (next.length > 0) {
      draftEditSeqRef.current += 1
      setAttachments(current => [...current, ...next])
    }
  }, [disabled, buildAttachmentEntries])

  if (addFilesRef) addFilesRef.current = addFiles

  const removeAttachment = useCallback((id) => {
    draftEditSeqRef.current += 1
    const current = attachmentsRef.current ?? []
    const target = current.find(item => item.id === id)
    if (target?.previewUrl) {
      ownedUrlsRef.current.delete(target.previewUrl)
      if (!heldFailedUrls.has(target.previewUrl) && !inFlightUrls.has(target.previewUrl)) revokeUrl(target.previewUrl)
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

  const withdrawIntoComposer = useCallback((withdrawnText) => {
    const incoming = String(withdrawnText ?? '').trim()
    if (incoming === '') return
    draftEditSeqRef.current += 1
    const merged = mergeRescuedDraft(textRef.current ?? '', incoming)
    textRef.current = merged
    setText(merged)
    setCaret(merged.length)
    const focusEnd = () => {
      field.current?.focus?.()
      field.current?.setSelectionRange?.(merged.length, merged.length)
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focusEnd)
    else focusEnd()
  }, [])

  const withdrawFnRef = useRef(withdrawIntoComposer)
  withdrawFnRef.current = withdrawIntoComposer
  useEffect(() => {
    const handler = incoming => withdrawFnRef.current(incoming)
    liveWithdrawByChat.set(chatKey, handler)
    return () => {
      if (liveWithdrawByChat.get(chatKey) === handler) liveWithdrawByChat.delete(chatKey)
    }
  }, [chatKey])

  if (withdrawRef) withdrawRef.current = withdrawIntoComposer

  const pushFailedSend = useCallback((targetKey, entry) => {
    trackFailedUrls(entry.items, true)
    const next = [...(pendingFailedByChat.get(targetKey) ?? []), entry]
    pendingFailedByChat.set(targetKey, next)
    if (mountedRef.current && chatKeyRef.current === targetKey) setFailedSends(next)
  }, [])

  const removeFailedSend = useCallback((entryId, { revoke = false, targetKey = chatKeyRef.current } = {}) => {
    const current = pendingFailedByChat.get(targetKey) ?? []
    const removed = current.find(item => item.id === entryId)
    const next = current.filter(item => item.id !== entryId)
    if (next.length > 0) pendingFailedByChat.set(targetKey, next)
    else pendingFailedByChat.delete(targetKey)
    if (removed) {
      trackFailedUrls(removed.items, false)
      for (const item of removed.items ?? []) {
        if (!item?.previewUrl) continue
        if (revoke) {
          ownedUrlsRef.current.delete(item.previewUrl)
          revokeUrl(item.previewUrl)
        } else {
          ownedUrlsRef.current.delete(item.previewUrl)
        }
      }
    }
    if (mountedRef.current && chatKeyRef.current === targetKey) setFailedSends(next)
  }, [])

  const retryFailedSend = useCallback(async (entry) => {
    if (disabled || retryingFailedId !== null) return
    const targetKey = chatKeyRef.current
    setRetryingFailedId(entry.id)
    setError(null)
    trackInFlightUrls(entry.items, true)
    try {
      await onSend(entry.text, entry.items)
      trackInFlightUrls(entry.items, false)
      removeFailedSend(entry.id, { revoke: false, targetKey })
    } catch (failure) {
      trackInFlightUrls(entry.items, false)
      const msg = failure?.message ?? String(failure)
      const next = (pendingFailedByChat.get(targetKey) ?? []).map(item => (
        item.id === entry.id ? { ...item, error: msg } : item
      ))
      if (next.length > 0) pendingFailedByChat.set(targetKey, next)
      if (mountedRef.current && chatKeyRef.current === targetKey) setFailedSends(next)
    } finally {
      if (mountedRef.current) setRetryingFailedId(cur => (cur === entry.id ? null : cur))
    }
  }, [disabled, retryingFailedId, onSend, removeFailedSend])

  const restoreFailedSend = useCallback((entry) => {
    const currentItems = attachmentsRef.current ?? []
    const incomingItems = entry.items ?? []
    if (incomingItems.length > 0) {
      const usedCost = currentItems.reduce((sum, item) => sum + stagedByteCost(item.size, item.isImage), 0)
      const addCost = incomingItems.reduce((sum, item) => sum + stagedByteCost(item.size, item.isImage), 0)
      if (usedCost + addCost > MAX_BATCH_STAGED_BYTES) {
        setError(t('File too large (max {size})', { size: '64 MB' }))
        return
      }
    }
    draftEditSeqRef.current += 1
    const nextText = entry.text ? mergeRescuedDraft(textRef.current ?? '', entry.text) : (textRef.current ?? '')
    textRef.current = nextText
    setText(nextText)
    setCaret(nextText.length)
    if (incomingItems.length > 0) {
      const rekeyed = incomingItems.map((item) => {
        if (item?.previewUrl) {
          heldFailedUrls.delete(item.previewUrl)
          ownedUrlsRef.current.add(item.previewUrl)
        }
        seqRef.current += 1
        return { ...item, id: `att-${seqRef.current}` }
      })
      setAttachments((current) => {
        const next = [...current, ...rekeyed]
        attachmentsRef.current = next
        return next
      })
    }
    const targetKey = chatKeyRef.current
    const nextList = (pendingFailedByChat.get(targetKey) ?? []).filter(item => item.id !== entry.id)
    if (nextList.length > 0) pendingFailedByChat.set(targetKey, nextList)
    else pendingFailedByChat.delete(targetKey)
    setFailedSends(nextList)
    setError(null)
    const focusEnd = () => {
      field.current?.focus?.()
      field.current?.setSelectionRange?.(nextText.length, nextText.length)
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focusEnd)
    else focusEnd()
  }, [])

  const runClassicCommand = useCallback(async (line, items = []) => {
    if (!isAgentChat || disabled || typeof actions?.runSessionCommand !== 'function') return false
    setError(null)
    setCommandNotice(null)
    const prevPlanActive = Boolean(classicControlsRef.current?.plan?.active)
    try {
      const extra = items.length > 0 ? await stageAttachmentItems(items, actions) : null
      const res = extra && (extra.images.length > 0 || extra.files.length > 0)
        ? await actions.runSessionCommand(sessionId, line, extra)
        : await actions.runSessionCommand(sessionId, line)
      if (res?.controls && mountedRef.current && chatKeyRef.current === chatKey) {
        setClassicControls(res.controls)
      }
      if (res?.matched === false) {
        setError(t('Couldn’t run command'))
        return false
      }
      if (res?.result?.kind === 'error') {
        setError(res.result.text || t('Couldn’t run command'))
        return false
      }
      const planToggled = res?.controls?.plan !== undefined && Boolean(res.controls.plan.active) !== prevPlanActive
      if (res?.result?.text && !planToggled && mountedRef.current && chatKeyRef.current === chatKey) {
        setCommandNotice(res.result.text)
      }
      return true
    } catch (failure) {
      setError(failure?.message ?? t('Couldn’t run command'))
      return false
    }
  }, [isAgentChat, disabled, actions, sessionId, chatKey])

  // Composer trigger menus: "+ → Reference a chat", "@mention" / "@file", and "/command" (+ skills/files in Classic).
  const rawTrigger = disabled ? null : (referenceTrigger
    ? { kind: 'reference', start: referenceTrigger.start, end: referenceTrigger.end, query: '' }
    : activeComposerTrigger(text, caret, { fileMentions: isAgentChat }))
  const triggerKey = rawTrigger ? `${rawTrigger.kind}:${rawTrigger.start}:${rawTrigger.query}` : null
  const trigger = rawTrigger && dismissedKey !== triggerKey ? rawTrigger : null

  useEffect(() => {
    if (!isAgentChat || trigger?.kind !== 'command') return
    void ensureClassicCommandsRef.current()
    void ensureClassicSkillsRef.current()
  }, [isAgentChat, sessionId, trigger?.kind])

  useEffect(() => {
    if (!isAgentChat || !trigger || (trigger.kind !== 'command' && trigger.kind !== 'mention')) return undefined
    if (typeof actions?.sessionFiles !== 'function') return undefined
    const seq = ++fileQuerySeq.current
    void Promise.resolve(actions.sessionFiles(sessionId, trigger.query ?? ''))
      .then((res) => {
        if (mountedRef.current && fileQuerySeq.current === seq && Array.isArray(res?.files)) {
          setClassicFiles(res.files)
        }
      })
      .catch(() => {})
    return undefined
  }, [isAgentChat, sessionId, trigger?.kind, trigger?.query, actions])

  const planActive = Boolean(classicControls?.plan && (classicControls.plan.pending ? !classicControls.plan.active : classicControls.plan.active))
  const classicCatalog = useMemo(() => (isAgentChat ? {
    commands: classicCommands,
    skills: classicSkills,
    files: classicFiles,
    planActive,
  } : null), [isAgentChat, classicCommands, classicSkills, classicFiles, planActive])

  const menuItems = useMemo(() => (trigger
    ? buildComposerMenuItems({
      mode: trigger.kind,
      query: trigger.query,
      quoted: trigger.quoted === true,
      roster,
      sessions,
      sessionId,
      actions,
      classicCatalog,
      onRunCommand: line => { void runClassicCommand(line) },
    })
    : []), [trigger, roster, sessions, sessionId, actions, classicCatalog, runClassicCommand])
  const clampedMenuIndex = menuItems.length > 0 ? Math.max(0, Math.min(menuIndex, menuItems.length - 1)) : 0
  useEffect(() => { setMenuIndex(0) }, [triggerKey])

  const closeMenu = () => {
    if (referenceTrigger) setReferenceTrigger(null)
    else if (triggerKey) setDismissedKey(triggerKey)
  }

  const selectMenuItem = (item) => {
    if (!item || !trigger) return
    draftEditSeqRef.current += 1
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

  const runningCommandForRef = useRef(null)
  const composingRef = useRef(false)
  const compositionEndAtRef = useRef(0)
  const isComposing = (event) => isImeComposing(event)
    || composingRef.current
    || (compositionEndAtRef.current > 0 && Date.now() - compositionEndAtRef.current < 50)
  const canSend = !disabled && (text.trim() !== '' || attachments.length > 0)
  const submit = async () => {
    const value = text.trim()
    const items = attachments.slice()
    if ((value === '' && items.length === 0) || disabled) return
    setError(null)
    setReferenceTrigger(null)
    setDismissedKey(null)
    const originChatId = chatId
    const originChatKey = chatKey
    const originSessionId = sessionId
    // In Classic mode, a leading `/cmd` matching a registered DSH host command executes
    // through `session-command-run` (forwarding any staged attachments) rather than sending
    // as an ordinary user message. Ensure commands are loaded even if the user submitted immediately.
    if (isAgentChat && value.startsWith('/') && typeof actions?.runSessionCommand === 'function') {
      if (runningCommandForRef.current === originChatKey) return
      const match = /^\/([a-z][a-z0-9_-]*)(?=$|\s)/i.exec(value)
      const cmdName = match?.[1]?.toLowerCase()
      if (cmdName) {
        runningCommandForRef.current = originChatKey
        let fellThrough = false
        try {
          const submitEditSeq = draftEditSeqRef.current
          const startDraftRev = originChatId ? (draftRevisions.get(originChatId) ?? 0) : null
          const commands = commandsLoadedForRef.current === originSessionId
            ? classicCommandsRef.current
            : await ensureClassicCommands()
          if (commands.some(cmd => cmd?.name === cmdName)) {
            const ok = await runClassicCommand(value, items)
            if (ok) {
              const untouchedLive = mountedRef.current
                && chatKeyRef.current === originChatKey
                && draftEditSeqRef.current === submitEditSeq
              if (untouchedLive) {
                for (const item of items) {
                  if (item.previewUrl) {
                    ownedUrlsRef.current.delete(item.previewUrl)
                    revokeUrl(item.previewUrl)
                  }
                }
                textRef.current = ''
                attachmentsRef.current = []
                setText('')
                setCaret(0)
                setAttachments([])
                if (originChatId) writeDraft({ chatId: originChatId, part: originSessionId, text: '', files: [] })
              } else if (originChatId && (draftRevisions.get(originChatId) ?? 0) === startDraftRev) {
                writeDraft({ chatId: originChatId, part: originSessionId, text: '', files: [] })
              }
            }
            return
          }
          if (!mountedRef.current || chatKeyRef.current !== originChatKey || draftEditSeqRef.current !== submitEditSeq) {
            return
          }
          fellThrough = true
        } finally {
          if (runningCommandForRef.current === originChatKey) runningCommandForRef.current = null
        }
        if (!fellThrough) return
      }
    }
    textRef.current = ''
    attachmentsRef.current = []
    setText('')
    setCaret(0)
    setAttachments([])
    const clearedRev = originChatId ? writeDraft({ chatId: originChatId, part: originSessionId, text: '', files: [] }) : null
    trackInFlightUrls(items, true)
    try {
      await onSend(value, items)
      trackInFlightUrls(items, false)
      // Hand previewUrl cleanup to Chat's pending-message lifecycle on success.
      for (const item of items) {
        if (item.previewUrl) ownedUrlsRef.current.delete(item.previewUrl)
      }
    } catch (failure) {
      trackInFlightUrls(items, false)
      const errMsg = failure?.message ?? String(failure)
      const activeBot = rosterRef.current?.byId?.[sessionIdRef.current]
      const activeRoom = rosterRef.current?.roomsById?.[sessionIdRef.current]
      const isSameChat = chatKeyRef.current === originChatKey
        || (Array.isArray(activeBot?.parts) && activeBot.parts.includes(originSessionId))
        || (Array.isArray(activeRoom?.parts) && activeRoom.parts.includes(originSessionId))
      if (!mountedRef.current || !isSameChat) {
        if (originChatId && draftRevisions.get(originChatId) === clearedRev) {
          writeDraft({
            chatId: originChatId,
            part: originSessionId,
            text: value,
            files: items.map(item => ({
              kind: item.isImage ? 'image' : 'file',
              file: item.file,
              ...(item.pastedText ? { pastedText: item.pastedText } : {}),
            })),
          })
          // `writeDraft` keeps the raw File objects; returning to this chat creates fresh URLs.
          for (const item of items) {
            if (item.previewUrl) {
              ownedUrlsRef.current.delete(item.previewUrl)
              if (!heldFailedUrls.has(item.previewUrl)) revokeUrl(item.previewUrl)
            }
          }
        } else {
          // A newer draft was written while this send was in flight: preserve the failed
          // message in the recovery shelf so neither the new draft nor the failed send is lost.
          pushFailedSend(originChatKey, {
            id: `fail-${++failedSendSeq}`,
            text: value,
            items,
            error: errMsg,
            time: Date.now(),
          })
        }
        return
      }
      const userAlreadyTyping = textRef.current !== '' || (attachmentsRef.current?.length ?? 0) > 0
      if (userAlreadyTyping) {
        // User already started typing the next message: keep their active draft untouched
        // and surface the failed message in the recovery shelf with Retry & Restore actions.
        pushFailedSend(chatKeyRef.current, {
          id: `fail-${++failedSendSeq}`,
          text: value,
          items,
          error: errMsg,
          time: Date.now(),
        })
        return
      }
      setText(() => {
        textRef.current = value
        return value
      })
      if (items.length > 0) {
        setAttachments(() => {
          attachmentsRef.current = items
          return items
        })
      }
      setError(errMsg)
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
      : isAgentChat ? t('Workspace files') : t('Mention a Bot')

  const userQueuedIds = useMemo(
    () => (Array.isArray(sessionQueue) ? sessionQueue.filter(item => item?.source?.kind === 'user').map(item => item.id) : EMPTY_LIST),
    [sessionQueue],
  )
  const canEnterSteer = enterToSend
    && !disabled
    && text === ''
    && attachments.length === 0
    && running
    && userQueuedIds.length > 0
    && typeof actions?.steerSessionQueue === 'function'
  const effectivePlaceholder = canEnterSteer ? t('Press Enter to steer queued messages') : placeholder

  const inputField = h('div', { className: 'dsb-composer-input', 'data-input-scroll': '' },
    h('textarea', {
      ref: field,
      rows: 1,
      value: text,
      disabled,
      placeholder: effectivePlaceholder,
      'aria-label': effectivePlaceholder,
      'data-bt-composer-input': '',
      onChange: (event) => {
        draftEditSeqRef.current += 1
        setText(event.target.value)
        setReferenceTrigger(null)
        setDismissedKey(null)
        const pos = event.target?.selectionStart
        setCaret(typeof pos === 'number' ? pos : event.target.value.length)
      },
      onCompositionStart: () => {
        composingRef.current = true
        compositionEndAtRef.current = 0
      },
      onCompositionEnd: () => {
        composingRef.current = false
        compositionEndAtRef.current = Date.now()
      },
      onClick: syncCaret,
      onKeyUp: (event) => {
        if (event?.key === 'Enter') compositionEndAtRef.current = 0
        syncCaret(event)
      },
      onSelect: syncCaret,
      onBlur: () => {
        composingRef.current = false
        compositionEndAtRef.current = 0
        lastEscAt.current = 0
        closeMenu()
      },
      onPaste,
      onKeyDown: (event) => {
        if (menuItems.length > 0 && !isComposing(event)) {
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
            lastEscAt.current = 0
            event.preventDefault()
            event.stopPropagation()
            closeMenu()
            return
          }
        }
        // Double-Escape within 500 ms stops the running turn while keeping queued messages.
        if (event.key === 'Escape' && !event.repeat && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && !isComposing(event)) {
          const overlayOpen = hasEscapeLayer() || (typeof document !== 'undefined' && Boolean(document.querySelector('[aria-modal="true"], [role="menu"], [role="dialog"]')))
          if (running && !stopping && typeof onStop === 'function' && !overlayOpen) {
            const now = Date.now()
            if (now - lastEscAt.current <= 500) {
              lastEscAt.current = 0
              event.preventDefault()
              event.stopPropagation()
              void stop()
              return
            }
            lastEscAt.current = now
            return
          }
          lastEscAt.current = 0
          return
        }
        if (event.key !== 'Escape') lastEscAt.current = 0
        const plainEnter = event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey
        const modEnter = event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey
        if ((enterToSend ? (plainEnter || modEnter) : modEnter) && !isComposing(event)) {
          // On an empty composer while running with queued user messages, Enter steers them now.
          if (text.trim() === '' && attachments.length === 0 && running && userQueuedIds.length > 0 && typeof actions?.steerSessionQueue === 'function') {
            event.preventDefault()
            if (steeringRef.current) return
            steeringRef.current = true
            void Promise.resolve(actions.steerSessionQueue(sessionId, userQueuedIds))
              .catch(err => actions?.reportError?.(err, 'queue'))
              .finally(() => { steeringRef.current = false })
            return
          }
          event.preventDefault()
          void submit()
        }
      },
    }))

  const trailingControls = h('div', { className: 'dsb-composer-trailing' },
    h(ComposerVoice, { sessionId, inputActions, actions, useUi, useRoster, voiceChat: !isAgentChat, disabled }),
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
    }, h(ArrowUpIcon)))

  return h('div', { className: 'dsb-composer-wrap' },
    h(FailedSendBar, {
      items: failedSends,
      disabled,
      retryingId: retryingFailedId,
      onRetry: entry => { void retryFailedSend(entry) },
      onRestore: restoreFailedSend,
      onDismiss: entry => removeFailedSend(entry.id, { revoke: true }),
    }),
    error ? h('p', { className: 'dsb-composer-error', role: 'alert' }, error) : null,
    !error && commandNotice ? h('div', { className: 'dsb-composer-notice', role: 'status' },
      h('span', { className: 'dsb-composer-notice-text' }, commandNotice),
      h('button', { type: 'button', className: 'dsb-composer-notice-x', 'aria-label': t('Dismiss'), onClick: () => setCommandNotice(null) }, h(CloseIcon))) : null,
    menuItems.length > 0 ? h(ComposerMenu, {
      items: menuItems,
      activeIndex: clampedMenuIndex,
      label: menuLabel,
      onHover: setMenuIndex,
      onSelect: selectMenuItem,
    }) : null,
    h('div', {
      className: 'dsb-composer',
      'data-bt-composer': '',
      'data-multiline': (text.includes('\n') || attachments.length > 0) || undefined,
      'data-running': (running && typeof onStop === 'function') || undefined,
      onMouseDown: (event) => {
        if (disabled || event.button !== 0) return
        const target = event.target
        if (!target) return
        // Ignore React portal events bubbling from dialogs/menus rendered outside the card DOM.
        if (typeof event.currentTarget?.contains === 'function' && !event.currentTarget.contains(target)) return
        if (typeof target.closest === 'function' && target.closest('textarea, input, button, a, select, label, [role="button"], [role="slider"], [contenteditable="true"]')) return
        event.preventDefault()
        field.current?.focus?.()
      },
    },
    h('input', { ref: fileInput, type: 'file', multiple: true, hidden: true, disabled, tabIndex: -1, onChange: onFilePick }),
    h(ComposerAttachments, { items: attachments, onRemove: removeAttachment, onPutBackPaste: putBackPaste }),
    isAgentChat
      ? h(Fragment, null,
        inputField,
        h('div', { className: 'dsb-classic-footer' },
          h('div', { className: 'dsb-classic-footer-left' },
            h('div', { className: 'dsb-composer-tools' },
              h(AgentComposerPlus, { disabled, fileInput, actions })),
            h(ClassicControls, {
              sessionId,
              controls: classicControls,
              roster,
              actions,
              disabled,
              onUpdated: setClassicControls,
            })),
          trailingControls))
      : h(Fragment, null,
        h('div', { className: 'dsb-composer-tools' },
          h(ComposerPlus, { sessionId, inputActions, useRoster, useWork, actions })),
        inputField,
        trailingControls)))
})

// Bottom area (all Docks, Queue Dock, and Composer). Isolated from the live streaming
// session subscription so streaming tokens never re-render the composer or any dock.
export const ComposerArea = memo(function ComposerArea({
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
  onSend,
  onStop,
  onWithdraw,
  popSubagent,
  actions,
  hooks,
  feed,
}) {
  const useWork = hooks.useWork ?? NO_WORK_HOOK
  const useUserQuestions = hooks.useUserQuestions ?? NO_LIST_HOOK
  const useSessionQueues = hooks.useSessionQueues ?? NO_OBJ_HOOK
  const useCards = hooks.useCards ?? NO_OBJ_HOOK
  const useHeldCards = hooks.useHeldCards ?? NO_OBJ_HOOK
  const useComputer = hooks.useComputer ?? NO_OBJ_HOOK
  const useBrowserHolds = hooks.useBrowserHolds ?? NO_OBJ_HOOK
  const useBrowserTabs = hooks.useBrowserTabs ?? NO_OBJ_HOOK
  const useBrowserPages = hooks.useBrowserPages ?? NO_OBJ_HOOK

  const sessionRunning = hooks.useSessionStatus(map => map.get(activeSessionId)?.running === true)
  const running = sessionRunning || (!isRoom && dmWriting)
  if (runningRef) runningRef.current = running

  const placeholder = waitingForModel
    ? t('Pick a model and {name} can start.', { name })
    : name ? t('Message {name}', { name }) : t('Message')

  return h('div', { ref: composerRootRef, className: 'dsb-composer-root' },
    !viewingSubagent ? h(MemoMemberDock, { sessionId: activeSessionId, useRoster: hooks.useRoster, useWork, useComputer, actions }) : null,
    !viewingSubagent ? h(MemoModelChoiceDock, { sessionId: activeSessionId, useRoster: hooks.useRoster, actions }) : null,
    !viewingSubagent ? h(MemoQuestionDock, { sessionId: activeSessionId, useRoster: hooks.useRoster, useCards, useHeldCards, actions }) : null,
    !isRoom && !viewingSubagent ? h(MemoWidgetDock, { sessionId: activeSessionId, useRoster: hooks.useRoster, useCards, useHeldCards, actions }) : null,
    !isRoom && !viewingSubagent ? h(MemoSecretDock, { sessionId: activeSessionId, useRoster: hooks.useRoster, useCards, useHeldCards, actions }) : null,
    !isRoom && !viewingSubagent ? h(MemoConnectorDock, { sessionId: activeSessionId, useRoster: hooks.useRoster, useCards, useHeldCards, actions }) : null,
    !isRoom && !viewingSubagent ? h(MemoMailDock, { sessionId: activeSessionId, useRoster: hooks.useRoster, useCards, useHeldCards, actions }) : null,
    !isRoom && !viewingSubagent ? h(MemoWorkPauseDock, { sessionId: activeSessionId, useRoster: hooks.useRoster, useWork, actions }) : null,
    !isRoom && !viewingSubagent ? h(MemoHandoffDock, { sessionId: activeSessionId, useRoster: hooks.useRoster, useCards, useHeldCards, useBrowserHolds, useBrowserTabs, useBrowserPages, actions }) : null,
    !isRoom && !viewingSubagent ? h(MemoComputerHandoffDock, { sessionId: activeSessionId, useRoster: hooks.useRoster, useCards, useHeldCards, useComputer, actions }) : null,
    !isRoom && !viewingSubagent ? h(MemoAppAccessDock, { sessionId: activeSessionId, useRoster: hooks.useRoster, useCards, useHeldCards, useComputer, actions }) : null,
    !isRoom && !viewingSubagent ? h(MemoApprovalDock, { botId, sessionId: activeSessionId, useWork, actions, readOnly }) : null,
    !isRoom && !viewingSubagent ? h(MemoClassicPlanReviewDock, { sessionId: activeSessionId, useUserQuestions, useRoster: hooks.useRoster, actions, readOnly }) : null,
    !isRoom && !viewingSubagent ? h(MemoClassicQuestionDock, { sessionId: activeSessionId, useUserQuestions, useRoster: hooks.useRoster, actions, readOnly }) : null,
    !isRoom && !viewingSubagent && typeof actions.turnFacts === 'function' && typeof actions.watchTurns === 'function' ? h(MemoBtwDock, { sessionId: activeSessionId, useRoster: hooks.useRoster, actions }) : null,
    !isRoom && !viewingSubagent && typeof actions.turnFacts === 'function' && typeof actions.watchTurns === 'function' ? h(MemoLearningDock, { sessionId: activeSessionId, useRoster: hooks.useRoster, actions }) : null,
    !viewingSubagent ? h(MemoDesktopQueueDock, {
      sessionId: activeSessionId,
      running,
      readOnly,
      useSessionQueues,
      pendingQueue,
      actions,
      classic: isClassic,
      onWithdraw,
    }) : null,
    viewingSubagent
      ? h(MemoSubagentReadOnlyBar, { onBack: popSubagent })
      : h(Composer, {
        sessionId: activeSessionId,
        disabled: locked,
        running,
        placeholder,
        onSend,
        onStop,
        addFilesRef,
        withdrawRef,
        insertQuoteRef,
        actions,
        feed,
        useUi: hooks.useUi,
        useRoster: hooks.useRoster,
        useWork,
        useSessions: hooks.useSessions,
        useSessionQueues,
        useRescuedDrafts: hooks.useRescuedDrafts,
      }))
})
