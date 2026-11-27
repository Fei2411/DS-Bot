import { createElement as h, Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChatsIcon, ClockIcon, GoalIcon, MicIcon, MoveIcon, PaperclipIcon, PeopleIcon, PlusIcon, WaveIcon } from './icons.js'
import { canSetGoal } from './goal.js'
import { BotMark } from './mark.js'
import { stepMenuFocus, useLinger, useViewport, viewBottom } from './motion.js'
import { hostText, t } from './i18n.js'
import { insertComposerNewline, sendsOnEnter } from './enter-key.js'
import { emptyAccelQueueKey, enterSteers, steerable } from './enter-steer.js'
import {
  captureAdmissionBaseline, chatOfSession, dropPartDraft, dropSentDraft,
  flushDrafts, hasLivePartDraft, hasOtherTabPartDraft, isSentAdmitted, keepDraft, keepDraftFiles, keepSentDraft,
  markSentAdmitted, maxUserSeqOf, peekSentDraft, takeDraft, takeSentDraft,
} from './draft-keep.js'
import { lruGet, lruSet } from './memo.js'
import { mergeRescuedDraft, readRescuedForChat } from './question-draft.js'
import { openCapture, speechCatalog, transcribeWave } from './speech.js'

// -------------------------------------------------------------------------
// Composer: dictation mic and the voice-chat button. The shell's send
// button stays the submit path; CSS swaps it with the voice button while the draft is
// empty (the send button is disabled then).

export const speechApi = () => window.SpeechRecognition ?? window.webkitSpeechRecognition
const keepComposerFocus = event => event.preventDefault()
const WORD_EDGE = /[\p{L}\p{N}]/u
const NON_SPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u

/** Add boundary spaces when dictating space-delimited words next to existing word characters. */
export function spacedDictation(text, beforeChar = '', afterChar = '') {
  if (!text) return ''
  const first = text[0]
  const last = text[text.length - 1]
  const needBefore = Boolean(beforeChar) && WORD_EDGE.test(beforeChar) && WORD_EDGE.test(first) && !NON_SPACED.test(beforeChar) && !NON_SPACED.test(first)
  const needAfter = Boolean(afterChar) && WORD_EDGE.test(last) && WORD_EDGE.test(afterChar) && !NON_SPACED.test(last) && !NON_SPACED.test(afterChar)
  return `${needBefore ? ' ' : ''}${text}${needAfter ? ' ' : ''}`
}

function dictationLimitMs(catalog) {
  const byDuration = Number.isFinite(catalog?.maxDurationSeconds) ? catalog.maxDurationSeconds : 120
  // 16 kHz mono PCM16 WAV = 32,000 bytes/sec + 44-byte header.
  const byBytes = Number.isFinite(catalog?.maxAudioBytes) ? Math.max(1, (catalog.maxAudioBytes - 44) / 32000) : byDuration
  return Math.max(1000, Math.floor((Math.min(byDuration, byBytes) - 0.5) * 1000))
}

export function useDictation(onText) {
  const [listening, setListening] = useState(false)
  const [note, setNote] = useState('')
  const recognition = useRef(null)
  const latest = useRef(onText)
  useEffect(() => { latest.current = onText }, [onText])
  useEffect(() => () => recognition.current?.abort(), [])
  useEffect(() => {
    if (!note) return undefined
    const timer = setTimeout(() => setNote(''), 2600)
    return () => clearTimeout(timer)
  }, [note])
  const start = ({ continuous = true, onEnd, onError } = {}) => {
    const Api = speechApi()
    if (!Api) { setNote(t('Dictation is not available in this browser')); return false }
    const engine = new Api()
    engine.lang = navigator.language || 'zh-CN'
    engine.interimResults = true
    engine.continuous = continuous
    engine.onresult = (event) => {
      let interim = ''
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]
        const text = result[0]?.transcript ?? ''
        if (result.isFinal) { if (text.trim()) latest.current(text, true) } else interim += text
      }
      if (interim) latest.current(interim, false)
    }
    engine.onerror = (event) => {
      if (event.error === 'aborted' || event.error === 'no-speech') return
      setNote(event.error === 'not-allowed' || event.error === 'service-not-allowed' ? t('Microphone access is blocked') : t("Couldn't hear that"))
      onError?.(event.error)
    }
    engine.onend = () => { setListening(false); recognition.current = null; onEnd?.() }
    recognition.current = engine
    try { engine.start(); setListening(true); return true } catch { setNote(t("Couldn't start dictation")); return false }
  }
  const stop = () => recognition.current?.stop()
  return { listening, note, start, stop }
}

export function ComposerVoice({ sessionId, inputActions, actions, useUi, useRoster, voiceChat = true, disabled = false }) {
  const enterToSend = useRoster(state => sendsOnEnter(state.prefs))
  const composerRoot = useRef(null)
  useEffect(() => {
    const root = composerRoot.current?.closest('[data-composer-card]')
    if (enterToSend || !inputActions || !root) return undefined
    const onKey = event => insertComposerNewline(event, inputActions)
    root.addEventListener('keydown', onKey, true)
    return () => root.removeEventListener('keydown', onKey, true)
  }, [enterToSend, inputActions])
  const dictation = useDictation((text, final) => {
    if (final && inputActions) inputActions.insertText(text, inputActions.captureInsertion())
  })
  const [hostListening, setHostListening] = useState(false)
  const [hostBusy, setHostBusy] = useState(false)
  const [hostNote, setHostNote] = useState('')
  const hostCapture = useRef(undefined)
  const hostCatalog = useRef(undefined)
  const hostAbort = useRef(undefined)
  const hostTimer = useRef(undefined)
  const hostGen = useRef(0)
  const mounted = useRef(true)
  const clearHostTimer = () => {
    if (hostTimer.current !== undefined) {
      clearTimeout(hostTimer.current)
      hostTimer.current = undefined
    }
  }
  const cancelHostDictation = () => {
    hostGen.current += 1
    clearHostTimer()
    hostAbort.current?.abort?.()
    hostAbort.current = undefined
    hostCapture.current?.cancel?.()
    hostCapture.current = undefined
    hostCatalog.current = undefined
    if (mounted.current) {
      setHostListening(false)
      setHostBusy(false)
    }
  }
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      hostGen.current += 1
      clearHostTimer()
      hostAbort.current?.abort?.()
      hostCapture.current?.cancel?.()
    }
  }, [])
  useEffect(() => {
    if (!hostNote) return undefined
    const timer = setTimeout(() => setHostNote(''), 2600)
    return () => clearTimeout(timer)
  }, [hostNote])
  const finishHostDictation = (limitReached = false) => {
    clearHostTimer()
    const cap = hostCapture.current
    const cat = hostCatalog.current
    if (!cap) return
    hostCapture.current = undefined
    setHostListening(false)
    const speech = actions.speech?.()
    if (!speech) {
      cap.cancel?.()
      return
    }
    setHostBusy(true)
    const ctl = new AbortController()
    hostAbort.current = ctl
    const maxSec = Math.min(
      Number.isFinite(cat?.maxDurationSeconds) ? cat.maxDurationSeconds : 120,
      Number.isFinite(cat?.maxAudioBytes) ? Math.max(1, (cat.maxAudioBytes - 44) / 32000) : 120,
    )
    void cap.finish(maxSec)
      .then(async (wave) => {
        if (!wave || ctl.signal.aborted || !mounted.current) return
        const text = await transcribeWave(speech, cat, wave, ctl.signal)
        if (text && inputActions && !ctl.signal.aborted && mounted.current) {
          const at = inputActions.captureInsertion()
          const area = composerRoot.current?.closest?.('[data-composer-card]')?.querySelector?.('textarea')
          const value = typeof area?.value === 'string' ? area.value : ''
          const beforeChar = at && at.start > 0 ? value[at.start - 1] ?? '' : ''
          const afterChar = at && at.end < value.length ? value[at.end] ?? '' : ''
          inputActions.insertText(spacedDictation(text, beforeChar, afterChar), at)
        }
        if (limitReached && mounted.current) setHostNote(t('That was too long to recognize'))
      })
      .catch((error) => {
        if (ctl.signal.aborted || !mounted.current) return
        const kind = error?.kind
        setHostNote(kind === 'too-long' ? t('That was too long to recognize') : t("Couldn't reach the speech service"))
      })
      .finally(() => {
        if (hostAbort.current === ctl) hostAbort.current = undefined
        if (mounted.current) setHostBusy(false)
      })
  }
  const toggleMic = () => {
    if (hostBusy) return
    if (dictation.listening) { dictation.stop(); return }
    if (hostListening && hostCapture.current) { finishHostDictation(false); return }
    const speech = actions.speech?.()
    if (!speech) {
      dictation.start()
      return
    }
    const gen = ++hostGen.current
    setHostBusy(true)
    void speechCatalog(speech)
      .then(async ({ catalog, usable }) => {
        if (!mounted.current || hostGen.current !== gen) return
        if (!usable) {
          if (speechApi()) {
            dictation.start()
            return
          }
          setHostNote(t('Voice input needs its speech model'))
          return
        }
        const cap = await openCapture()
        if (!mounted.current || hostGen.current !== gen) { cap.cancel(); return }
        hostCatalog.current = catalog
        hostCapture.current = cap
        setHostListening(true)
        clearHostTimer()
        hostTimer.current = setTimeout(() => { finishHostDictation(true) }, dictationLimitMs(catalog))
      })
      .catch((error) => {
        if (!mounted.current || hostGen.current !== gen) return
        const kind = error?.kind
        setHostNote(kind === 'blocked' ? t('Microphone access is blocked') : t("Couldn't start dictation"))
      })
      .finally(() => { if (mounted.current && hostGen.current === gen) setHostBusy(false) })
  }
  const openVoiceChat = () => {
    if (dictation.listening) dictation.stop()
    if (hostListening || hostBusy || hostCapture.current || hostAbort.current) cancelHostDictation()
    actions.openVoice(sessionId)
  }
  // Reply from a message's hover toolbar quotes it into this composer.
  const quote = useUi(state => (state.quote?.sessionId === sessionId ? state.quote : null))
  useEffect(() => {
    if (!quote || !inputActions) return
    actions.clearQuote(quote.token)
    const excerpt = quote.text.replace(/\s+/g, ' ').trim()
    const line = `> ${excerpt.length > 200 ? `${excerpt.slice(0, 200)}…` : excerpt}\n\n`
    inputActions.insertText(line, inputActions.captureInsertion())
    const box = document.querySelector('[class*="_centerCol"] [role=textbox][contenteditable=true]')
    if (box instanceof HTMLElement) {
      box.focus()
      const selection = window.getSelection()
      selection?.selectAllChildren(box)
      selection?.collapseToEnd()
    }
  }, [quote?.token])
  if (sessionId === undefined) return null
  // With DSH Web's Voice Input UI plugin on, its own microphone sits in this composer.
  // DS Bot's own desktop window provides no separate DSH UI mic, so it keeps this button
  // and routes dictation straight through the host speech controller.
  const pluginMic = typeof actions.hasPluginMic === 'function' ? actions.hasPluginMic() : actions.speech() !== undefined
  const listening = dictation.listening || hostListening
  const note = hostNote || dictation.note
  return h(Fragment, null,
    pluginMic ? (voiceChat ? null : h('span', { ref: composerRoot, hidden: true })) : h('button', {
      ref: voiceChat ? undefined : composerRoot,
      type: 'button', className: 'bt-mic', 'aria-label': listening ? t('Stop dictation') : t('Dictate'),
      'aria-pressed': listening, title: listening ? t('Stop dictation') : t('Dictate'),
      disabled: disabled || hostBusy,
      onMouseDown: keepComposerFocus, onClick: toggleMic,
    }, h(MicIcon)),
    voiceChat ? h('button', {
      ref: composerRoot, type: 'button', className: 'bt-voice', 'aria-label': t('Start voice chat'), title: t('Voice chat'),
      disabled,
      onMouseDown: keepComposerFocus, onClick: openVoiceChat,
    }, h(WaveIcon, { size: 18 })) : null,
    note ? h('span', { className: 'bt-mic-note', role: 'status' }, note) : null)
}

// Character marks for the "@" menu rows. Each Bot keeps one component, so the menu
// does not remount its mark on every keystroke.
const MAX_MENU_MARKS = 200
export function menuIcons(roster) {
  const marks = new Map()
  return (row) => {
    if (!row.bot) return PeopleIcon
    const id = row.bot.id
    const cached = lruGet(marks, id)
    if (cached !== undefined) return cached
    const byId = roster.getSnapshot().byId ?? {}
    if (marks.size >= MAX_MENU_MARKS) {
      for (const known of marks.keys()) {
        if (byId[known] === undefined) marks.delete(known)
      }
    }
    const Icon = ({ size = 14 }) => h(BotMark, { bot: roster.getSnapshot().byId[id] ?? row.bot, size })
    lruSet(marks, id, Icon, MAX_MENU_MARKS)
    return Icon
  }
}

// The composer's "+" in a Bot's chat or a group chat: add files, reference another
// chat, or set a scheduled task for this chat. It stands in for the shell's command
// menu, whose plan, permission, model and compact rows reach past what DS Bot keeps
// for its Bots; "/" still opens that menu. Files go through the shell's own file
// input beside it.
export function ComposerPlus({ sessionId, inputActions, useInput, useRoster, useWork, actions }) {
  const roster = useRoster(value => value)
  const enterToSend = sendsOnEnter(roster.prefs)
  const bgInfo = useWork?.(work => work.canBackground?.[sessionId])
  const [open, setOpen] = useState(null)
  const [shown, leaving] = useLinger(open, 120)
  const button = useRef(null)
  const menu = useRef(null)
  const tick = useViewport(Boolean(shown))
  // The selector runs on every input change, so inputNow stays live for the key
  // handler while `ready` re-renders only when steerability flips.
  const inputNow = useRef(undefined)
  const ready = useInput?.((state) => { inputNow.current = state; return steerable(state) }) === true && enterToSend
  const target = roster.byId?.[sessionId]?.id ?? roster.roomsById?.[sessionId]?.id
  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => { if (![button.current, menu.current].some(node => node?.contains(event.target))) setOpen(null) }
    const onKey = (event) => {
      if (stepMenuFocus(menu.current, event, button.current)) return
      if (event.key === 'Escape') { event.stopPropagation(); setOpen(null) }
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('mousedown', onDown, true); window.removeEventListener('keydown', onKey, true) }
  }, [open])
  useEffect(() => {
    const card = button.current?.closest('[data-composer-card]')
    if (!ready || card === null || card === undefined) return undefined
    const next = JSON.stringify(t('Press Enter to steer queued messages'))
    if (card.style.getPropertyValue('--bt-placeholder') !== next) card.style.setProperty('--bt-placeholder', next)
    return () => {
      if (card.style.getPropertyValue('--bt-placeholder') === next) card.style.removeProperty('--bt-placeholder')
    }
  }, [ready, sessionId, target])
  useEffect(() => {
    let steering = false
    const onKey = (event) => {
      if (event.defaultPrevented || open) return
      // Check key/steerability before touching the DOM so regular typing does zero queries (#1812).
      const plainEnter = enterSteers(event, inputNow.current, enterToSend)
      const accelEnter = !plainEnter && emptyAccelQueueKey(event, inputNow.current)
      if (!plainEnter && !accelEnter) return
      const targetEl = event.target
      if (typeof targetEl?.closest !== 'function') return
      const card = button.current?.closest('[data-composer-card]')
      if (card === null || card === undefined || targetEl.closest('[data-composer-card]') !== card) return
      if (targetEl.closest('[contenteditable=true]') === null) return
      if (targetEl.closest('[data-composer-composing]')) return
      if (targetEl.ownerDocument?.querySelector('[role="listbox"]')) return
      event.preventDefault()
      event.stopPropagation()
      if (steering || !steerable(inputNow.current)) return
      steering = true
      void Promise.resolve(actions.steerQueued(sessionId)).finally(() => { steering = false })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, sessionId, enterToSend])
  // Hooks stay above the early return below: the roster may not know the Bot yet, and a
  // render that skips a hook breaks the composer's slot when the roster arrives.
  // Anchored to the "+" after layout: the visible viewport can move (on-screen keyboard)
  // while the menu is open.
  const [place, setPlace] = useState(undefined)
  useLayoutEffect(() => {
    if (!shown || !button.current) { setPlace(undefined); return }
    const rect = button.current.getBoundingClientRect()
    const cardTop = button.current.closest?.('[data-composer-card]')?.getBoundingClientRect?.().top ?? rect.top
    setPlace({ left: rect.left, bottom: viewBottom() - Math.min(rect.top, cardTop) + 8 })
  }, [shown, open, tick])
  if (sessionId === undefined || target === undefined) return null
  const fileInput = () => button.current?.closest('[data-composer-card]')?.querySelector('input[type=file]')
  const toggle = () => {
    if (open) { setOpen(null); return }
    // Files go through the composer's own file input; a composer without one takes none.
    setOpen({ files: Boolean(fileInput()) })
  }
  const attach = () => {
    setOpen(null)
    fileInput()?.click()
  }
  const schedule = () => {
    setOpen(null)
    actions.openSettings('schedules', target)
  }
  // The chats open in the shell's "@" menu at the caret, so the pick lands where the
  // user was typing.
  const reference = () => {
    setOpen(null)
    actions.referenceChat(sessionId, inputActions?.captureInsertion?.())
  }
  const canReference = typeof inputActions?.captureInsertion === 'function' && actions.canReferenceChat()
  const room = roster.roomsById?.[sessionId]
  const goal = () => {
    setOpen(null)
    actions.composeGoal(room.id)
  }
  const moveToBackground = () => {
    setOpen(null)
    if (!bgInfo || typeof actions.moveToBackground !== 'function') return
    void Promise.resolve(actions.moveToBackground(bgInfo.botId, sessionId, bgInfo.turn))
      .catch(error => actions.reportError?.(new Error(hostText(error?.message ?? String(error))), 'move-to-background'))
  }
  return h(Fragment, null,
    h('button', {
      ref: button, type: 'button', className: 'bt-plus', 'aria-label': t('Add'), title: t('Add'),
      'aria-haspopup': 'menu', 'aria-expanded': Boolean(open), onMouseDown: keepComposerFocus, onClick: toggle,
    }, h(PlusIcon)),
    shown ? createPortal(h('div', {
      ref: menu, className: 'bt-menu bt-menu-up bt-plus-menu', role: 'menu', 'aria-label': t('Add'),
      style: place ?? {}, 'data-leaving': leaving || undefined,
    },
    shown.files ? h('button', { type: 'button', role: 'menuitem', onClick: attach }, h(PaperclipIcon), h('span', { className: 'bt-menu-label' }, t('Add files'))) : null,
    canReference ? h('button', { type: 'button', role: 'menuitem', onMouseDown: keepComposerFocus, onClick: reference }, h(ChatsIcon), h('span', { className: 'bt-menu-label' }, t('Reference a chat'))) : null,
    canSetGoal(room, roster) ? h('button', { type: 'button', role: 'menuitem', onClick: goal }, h(GoalIcon), h('span', { className: 'bt-menu-label' }, t('Set a goal'))) : null,
    bgInfo && typeof actions.moveToBackground === 'function' ? h('button', { type: 'button', role: 'menuitem', onMouseDown: keepComposerFocus, onClick: moveToBackground }, h(MoveIcon), h('span', { className: 'bt-menu-label' }, t('Move current work to background'))) : null,
    h('button', { type: 'button', role: 'menuitem', onClick: schedule }, h(ClockIcon), h('span', { className: 'bt-menu-label' }, t('Scheduled task')))), document.body) : null)
}

const NO_IDS = []
const NO_QUEUE = []
const NO_SUBMISSIONS = []
const FROZEN_PHASES = new Set(['adjudicating', 'submitting', 'sending'])
const DRAFT_DEBOUNCE_MS = 300

const appendRescuedPreservingChips = (inputActions, base, rescued) => {
  const merged = mergeRescuedDraft(base, rescued)
  if (merged === base) return { applied: true, changed: false, nextText: base }
  if (typeof inputActions.captureInsertion !== 'function' || typeof inputActions.insertText !== 'function') {
    return { applied: false, changed: false, nextText: base }
  }
  const span = inputActions.captureInsertion()
  if (span === undefined || span === null || typeof span.end !== 'number' || typeof span.draftRev !== 'number') {
    return { applied: false, changed: false, nextText: base }
  }
  const addition = base.trim() === ''
    ? rescued.trim()
    : `${base.endsWith('\n\n') ? '' : (base.endsWith('\n') ? '\n' : '\n\n')}${rescued.trim()}`
  const ok = inputActions.insertText(addition, { start: span.end, end: span.end, draftRev: span.draftRev })
  return { applied: ok === true, changed: ok === true, nextText: ok === true ? merged : base }
}

// An unsent draft stays with its chat (draft-keep.js). Sits in the composer of every Bot
// and group Session and renders nothing.
export function DraftKeeper({
  sessionId, inputActions, useInput, useSession, useConversation, useProjection,
  useRoster, useRescuedDrafts, actions,
}) {
  const chatId = useRoster(roster => chatOfSession(roster, sessionId)?.id)
  const current = useRoster(roster => chatOfSession(roster, sessionId)?.part === sessionId)
  const draft = useInput?.(state => state.draft) ?? ''
  const ids = useInput?.(state => state.attachmentIds) ?? NO_IDS
  const phase = useInput?.(state => state.phase) ?? 'plain'
  const queue = useInput?.(state => state.queue) ?? NO_QUEUE
  const occurrences = useInput?.(state => state.occurrences) ?? NO_IDS
  const hasChips = Array.isArray(occurrences) && occurrences.length > 0
  const openState = useSession?.(state => state?.openState)
  const pendingSubmissions = useSession?.(state => state?.pendingSubmissions) ?? NO_SUBMISSIONS
  const nextStep = useProjection?.('inbox', inbox => inbox?.['next-step']) ?? NO_QUEUE
  const rescued = useRescuedDrafts?.(state => readRescuedForChat(state, chatId, sessionId)) ?? ''
  const frozen = FROZEN_PHASES.has(phase)
  // Only an ordinary message send has a text that may never come back: a command's
  // draft is still the user's, however its slash adjudication settles.
  const sending = phase === 'sending'
  // setDraft cancels a claimed slash command; wait for plain phase before landing rescued text.
  const rescueBlocked = frozen || phase === 'claimed'
  const key = `${chatId}:${sessionId}`
  // Return a primitive seq while idle so streaming assistant chunks do not re-render the
  // keeper; return the live chat snapshot only when an active send or watch needs inspection.
  const chatOrSeq = useConversation?.((conversation) => {
    const chatSnapshot = conversation?.views?.get?.('chat')
    if (!current) return 0
    if (!sending && peekSentDraft({ chatId, sessionId }) === undefined) return maxUserSeqOf(chatSnapshot)
    return chatSnapshot
  }) ?? 0
  const chat = typeof chatOrSeq === 'object' && chatOrSeq !== null ? chatOrSeq : undefined
  const lastUserSeq = typeof chatOrSeq === 'number' ? chatOrSeq : maxUserSeqOf(chat)

  const keyRef = useRef(key)
  const restored = useRef('')
  const deferredRestore = useRef(false)
  const skippedLiveDraft = useRef(null)
  // What was just put back (or cleared) and has not reached the input state yet.
  const pending = useRef({ text: false, staleDraft: null, files: false })
  const latestDraft = useRef(draft)
  // Continuously refreshed while !frozen so a fast local Host acceptance on the first
  // 'sending' render cannot fold the new message into its own baseline.
  const preSendBaseline = useRef(null)

  useEffect(() => {
    if (keyRef.current !== key) {
      keyRef.current = key
      deferredRestore.current = false
      skippedLiveDraft.current = null
      pending.current = { text: false, staleDraft: null, files: false }
      latestDraft.current = draft
    } else if (!pending.current.text || draft !== pending.current.staleDraft) {
      latestDraft.current = draft
    }
  }, [key, draft])

  useEffect(() => {
    if (!current || frozen) return
    preSendBaseline.current = {
      key,
      baseline: captureAdmissionBaseline({
        maxUserSeq: lastUserSeq,
        pendingSubmissions,
        queue,
        nextStep,
      }),
    }
  }, [current, frozen, key, lastUserSeq, pendingSubmissions, queue, nextStep])

  useEffect(() => {
    const flush = () => flushDrafts()
    const onVisibility = () => { if (document.hidden === true) flush() }
    const hasWin = typeof window !== 'undefined' && typeof window.addEventListener === 'function'
    const hasDoc = typeof document !== 'undefined' && typeof document.addEventListener === 'function'
    if (hasWin) {
      window.addEventListener('pagehide', flush)
      window.addEventListener('beforeunload', flush)
    }
    if (hasDoc) document.addEventListener('visibilitychange', onVisibility)
    return () => {
      if (hasWin) {
        window.removeEventListener('pagehide', flush)
        window.removeEventListener('beforeunload', flush)
      }
      if (hasDoc) document.removeEventListener('visibilitychange', onVisibility)
      flush()
    }
  }, [chatId, sessionId])

  // Take back first, so the empty box of a composer that just opened is not kept over
  // the draft it is about to get. While a send is in flight the shell refuses edits, so
  // wait for the submit plane to settle and leave the kept draft untouched.
  let rescuedHandled = false
  useEffect(() => {
    if (!current || frozen || inputActions === undefined) return
    if (restored.current === key) return
    // The box may hold the text of a message that was already sent, when its send closed
    // the composer before the shell committed the empty draft (#1891). Clear it only once
    // Host admission is confirmed (not merely attempted) and no other tab wrote a fresh
    // unsent draft for this Session since the send started.
    let effectiveDraft = draft
    let clearSent = false
    const watch = peekSentDraft({ chatId, sessionId })
    if (watch !== undefined) {
      const livePartDraft = hasLivePartDraft({ chatId, part: sessionId })
      if (draft !== watch.text || livePartDraft) {
        dropSentDraft({ chatId, sessionId })
      } else if (isSentAdmitted(watch, { chat, pendingSubmissions, queue, nextStep })) {
        takeSentDraft({ chatId, sessionId })
        effectiveDraft = ''
        clearSent = true
      } else if (openState === 'cold' || openState === 'loading') {
        deferredRestore.current = true
        return
      } else {
        dropSentDraft({ chatId, sessionId })
      }
    }
    const back = takeDraft({ chatId, part: sessionId, text: effectiveDraft, attached: ids.length })
    const canLandRescueHere = rescued !== '' && !rescueBlocked && (!hasChips || back.text !== '' || clearSent)
    const baseText = back.text !== '' ? back.text : effectiveDraft
    const mergedText = canLandRescueHere ? mergeRescuedDraft(baseText, rescued) : back.text
    const nextText = canLandRescueHere ? mergedText : (back.text !== '' ? back.text : (clearSent ? '' : null))
    const applyText = nextText !== null && nextText !== draft
    if (canLandRescueHere) rescuedHandled = true
    let added = []
    let attached = false
    let restoredText = false
    let restoredFiles = false
    let ok = true
    try {
      if (applyText) {
        inputActions.setDraft(nextText)
        restoredText = true
        latestDraft.current = nextText
      }
      if (canLandRescueHere) {
        actions.consumeRescuedDraft?.(chatId, sessionId, rescued)
        if (restoredText && back.files.length === 0) {
          keepDraft({ chatId, part: sessionId, text: mergedText, files: actions.draftFiles?.(ids) ?? [] })
        }
      }
      if (back.files.length > 0) {
        added = actions.restoreDraftFiles(sessionId, back.files.map(item => item.file))
        if (added.length > 0 && inputActions.addAttachments(added) !== false) {
          attached = true
          restoredFiles = true
          actions.reopenPastes(back.from, sessionId)
        } else {
          if (added.length > 0) actions.releaseDraftFiles?.(added)
          ok = false
        }
      }
    } catch (error) {
      if (added.length > 0 && !attached) actions.releaseDraftFiles?.(added)
      ok = false
      console.warn('[ds-bot] could not put the draft back', error)
    }
    // A restore that failed outside a send is not tried again on every later send: the
    // draft is kept from what the box holds now, and the user hears the files are gone.
    pending.current = { text: restoredText, staleDraft: restoredText ? draft : null, files: restoredFiles }
    restored.current = key
    if (!restoredText && !clearSent && hasOtherTabPartDraft({ chatId, part: sessionId, text: draft })) {
      skippedLiveDraft.current = { key, draft }
    }
    const wasDeferred = deferredRestore.current
    deferredRestore.current = false
    if (wasDeferred && !restoredText && !restoredFiles && (draft !== '' || ids.length > 0)) {
      const files = actions.draftFiles?.(ids) ?? []
      if (hasLivePartDraft({ chatId, part: sessionId })) {
        if (files.length > 0) keepDraftFiles({ chatId, part: sessionId, files })
      } else {
        keepDraft({ chatId, part: sessionId, text: draft, files }, undefined, { deferMs: DRAFT_DEBOUNCE_MS })
      }
    }
    if (!ok && back.files.length > 0) actions.notice?.(t('The files attached to this draft could not be put back.'))
  }, [current, frozen, rescueBlocked, hasChips, chatId, sessionId, key, inputActions, draft, rescued, openState, chat, lastUserSeq, pendingSubmissions, queue, nextStep])

  // Rescued text from an interrupted question card lands live once this composer is plain & editable.
  useEffect(() => {
    if (rescuedHandled || !current || rescueBlocked || inputActions === undefined || rescued === '' || restored.current !== key) return
    const base = latestDraft.current
    try {
      if (hasChips) {
        const result = appendRescuedPreservingChips(inputActions, base, rescued)
        if (!result.applied) return
        if (result.changed) {
          pending.current = { ...pending.current, text: true, staleDraft: draft }
          latestDraft.current = result.nextText
          keepDraft({ chatId, part: sessionId, text: result.nextText, files: actions.draftFiles?.(ids) ?? [] })
        }
        actions.consumeRescuedDraft?.(chatId, sessionId, rescued)
        return
      }
      const merged = mergeRescuedDraft(base, rescued)
      if (merged !== base) {
        inputActions.setDraft(merged)
        pending.current = { ...pending.current, text: true, staleDraft: draft }
        latestDraft.current = merged
        keepDraft({ chatId, part: sessionId, text: merged, files: actions.draftFiles?.(ids) ?? [] })
      }
      actions.consumeRescuedDraft?.(chatId, sessionId, rescued)
    } catch (error) {
      console.warn('[ds-bot] could not return the question draft', error)
    }
  }, [current, rescueBlocked, hasChips, chatId, sessionId, key, inputActions, rescued])

  // Observe Host admission for an in-flight send (or an existing un-admitted watch) without
  // re-running draft persistence on unrelated queue, steering, or transcript updates.
  useEffect(() => {
    if (!current) return
    const existing = peekSentDraft({ chatId, sessionId })
    if (!sending) {
      if (existing !== undefined && !existing.admitted && isSentAdmitted(existing, { chat, pendingSubmissions, queue, nextStep })) {
        markSentAdmitted({ chatId, sessionId })
      }
      return
    }
    const admissionState = { chat, pendingSubmissions, queue, nextStep }
    if (draft === '') {
      if (existing !== undefined && !existing.admitted && isSentAdmitted(existing, admissionState)) {
        markSentAdmitted({ chatId, sessionId })
      }
      return
    }
    if (existing?.text === draft) {
      if (!existing.admitted && isSentAdmitted(existing, admissionState)) markSentAdmitted({ chatId, sessionId })
      return
    }
    const baseline = preSendBaseline.current?.key === key
      ? preSendBaseline.current.baseline
      : captureAdmissionBaseline({ ...admissionState, maxUserSeq: lastUserSeq })
    keepSentDraft({ chatId, sessionId, text: draft, baseline })
    const created = peekSentDraft({ chatId, sessionId })
    if (isSentAdmitted(created, admissionState)) markSentAdmitted({ chatId, sessionId })
  }, [current, sending, key, chatId, sessionId, draft, chat, lastUserSeq, pendingSubmissions, queue, nextStep])

  // Persist draft edits and phase transitions only; never subscribe to queue or transcript
  // churn here so an untouched empty composer cannot overwrite another tab's fresh draft.
  useEffect(() => {
    if (!current) return
    if (frozen) {
      // Before the take, an earlier part's draft still waits to be carried; only a draft
      // this part owns is dropped.
      if (restored.current === key) keepDraft({ chatId, part: sessionId, text: '', files: [] })
      else if (sending) dropPartDraft({ chatId, part: sessionId })
      return
    }
    if (restored.current !== key) return
    // The composer is open and the send has settled: the text cannot come back now.
    dropSentDraft({ chatId, sessionId })
    // What was put back (or cleared) lands in the input state a render later; keeping the
    // stale box in between would drop the restored text or re-keep the sent text.
    if (pending.current.text && draft === pending.current.staleDraft) return
    if (pending.current.files && ids.length === 0) return
    pending.current = { text: false, staleDraft: null, files: false }
    if (skippedLiveDraft.current?.key === key) {
      if (draft === skippedLiveDraft.current.draft) {
        keepDraftFiles({ chatId, part: sessionId, files: actions.draftFiles?.(ids) ?? [] })
        return
      }
      skippedLiveDraft.current = null
    }
    keepDraft({ chatId, part: sessionId, text: draft, files: actions.draftFiles(ids) }, undefined, { deferMs: DRAFT_DEBOUNCE_MS })
  }, [current, sending, frozen, key, chatId, sessionId, draft, ids])
  return null
}
