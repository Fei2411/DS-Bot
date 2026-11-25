import { createElement as h, Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChatsIcon, ClockIcon, GoalIcon, MicIcon, MoveIcon, PaperclipIcon, PeopleIcon, PlusIcon, WaveIcon } from './icons.js'
import { canSetGoal } from './goal.js'
import { BotMark } from './mark.js'
import { stepMenuFocus, useLinger, useViewport, viewBottom } from './motion.js'
import { hostText, t } from './i18n.js'
import { insertComposerNewline, sendsOnEnter } from './enter-key.js'
import { emptyAccelQueueKey, enterSteers, steerable } from './enter-steer.js'
import { chatOfSession, flushDrafts, keepDraft, takeDraft } from './draft-keep.js'
import { lruGet, lruSet } from './memo.js'
import { mergeRescuedDraft, readRescuedForChat } from './question-draft.js'

// -------------------------------------------------------------------------
// Composer: dictation mic and the voice-chat button. The shell's send
// button stays the submit path; CSS swaps it with the voice button while the draft is
// empty (the send button is disabled then).

export const speechApi = () => window.SpeechRecognition ?? window.webkitSpeechRecognition
const keepComposerFocus = event => event.preventDefault()

export function useDictation(onText) {
  const [listening, setListening] = useState(false)
  const [note, setNote] = useState('')
  const recognition = useRef(null)
  const latest = useRef(onText)
  latest.current = onText
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

export function ComposerVoice({ sessionId, inputActions, actions, useUi, useRoster }) {
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
  // With the Voice Input plugin on, its own microphone sits in this composer.
  const pluginMic = actions.speech() !== undefined
  return h(Fragment, null,
    pluginMic ? null : h('button', {
      type: 'button', className: 'bt-mic', 'aria-label': dictation.listening ? t('Stop dictation') : t('Dictate'),
      'aria-pressed': dictation.listening, title: dictation.listening ? t('Stop dictation') : t('Dictate'),
      onMouseDown: keepComposerFocus, onClick: () => (dictation.listening ? dictation.stop() : dictation.start()),
    }, h(MicIcon)),
    h('button', {
      ref: composerRoot, type: 'button', className: 'bt-voice', 'aria-label': t('Start voice chat'), title: t('Voice chat'),
      onMouseDown: keepComposerFocus, onClick: () => actions.openVoice(sessionId),
    }, h(WaveIcon, { size: 18 })),
    dictation.note ? h('span', { className: 'bt-mic-note', role: 'status' }, dictation.note) : null)
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
  // Anchored to the "+" each render: the visible viewport can move (on-screen
  // keyboard) while the menu is open.
  const place = useMemo(() => {
    if (!shown || !button.current) return null
    const rect = button.current.getBoundingClientRect()
    const cardTop = button.current.closest?.('[data-composer-card]')?.getBoundingClientRect?.().top ?? rect.top
    return { left: rect.left, bottom: viewBottom() - Math.min(rect.top, cardTop) + 8 }
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
export function DraftKeeper({ sessionId, inputActions, useInput, useRoster, useRescuedDrafts, actions }) {
  const chatId = useRoster(roster => chatOfSession(roster, sessionId)?.id)
  const current = useRoster(roster => chatOfSession(roster, sessionId)?.part === sessionId)
  const draft = useInput?.(state => state.draft) ?? ''
  const ids = useInput?.(state => state.attachmentIds) ?? NO_IDS
  const phase = useInput?.(state => state.phase) ?? 'plain'
  const occurrences = useInput?.(state => state.occurrences) ?? NO_IDS
  const hasChips = Array.isArray(occurrences) && occurrences.length > 0
  const rescued = useRescuedDrafts?.(state => readRescuedForChat(state, chatId, sessionId)) ?? ''
  const frozen = FROZEN_PHASES.has(phase)
  // setDraft cancels a claimed slash command; wait for plain phase before landing rescued text.
  const rescueBlocked = frozen || phase === 'claimed'
  const key = `${chatId}:${sessionId}`
  const keyRef = useRef(key)
  const restored = useRef('')
  // What was just put back and has not reached the input state yet.
  const pending = useRef({ text: false, staleDraft: null, files: false })
  const latestDraft = useRef(draft)
  if (keyRef.current !== key) {
    keyRef.current = key
    pending.current = { text: false, staleDraft: null, files: false }
    latestDraft.current = draft
  } else if (!pending.current.text || draft !== pending.current.staleDraft) {
    latestDraft.current = draft
  }
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
    const back = takeDraft({ chatId, part: sessionId, text: draft, attached: ids.length })
    const canLandRescueHere = rescued !== '' && !rescueBlocked && (!hasChips || back.text !== '')
    const baseText = back.text !== '' ? back.text : draft
    const mergedText = canLandRescueHere ? mergeRescuedDraft(baseText, rescued) : back.text
    const applyText = canLandRescueHere ? mergedText !== draft : back.text !== ''
    if (canLandRescueHere) rescuedHandled = true
    let added = []
    let attached = false
    let restoredText = false
    let restoredFiles = false
    let ok = true
    try {
      if (applyText) {
        inputActions.setDraft(mergedText)
        restoredText = true
        latestDraft.current = mergedText
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
    if (!ok && back.files.length > 0) actions.notice?.(t('The files attached to this draft could not be put back.'))
  }, [current, frozen, chatId, sessionId, inputActions])
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
  }, [current, rescueBlocked, hasChips, chatId, sessionId, inputActions, rescued])
  useEffect(() => {
    if (!current || restored.current !== key) return
    // A draft on its way out is no longer kept: should the composer close before the
    // Host takes it, the sent images must not come back as a draft. A send that fails
    // returns to the plain phase with its draft, which is then kept again.
    if (frozen) {
      keepDraft({ chatId, part: sessionId, text: '', files: [] })
      return
    }
    // What was put back lands in the input state a render later; keeping the empty box
    // in between would drop it.
    if (pending.current.text && draft === pending.current.staleDraft) return
    if (pending.current.files && ids.length === 0) return
    pending.current = { text: false, staleDraft: null, files: false }
    keepDraft({ chatId, part: sessionId, text: draft, files: actions.draftFiles(ids) }, undefined, { deferMs: DRAFT_DEBOUNCE_MS })
  }, [current, frozen, chatId, sessionId, draft, ids])
  return null
}
