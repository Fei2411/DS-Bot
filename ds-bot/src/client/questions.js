import { createElement as h, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ChevronDownIcon, CloseIcon, CheckIcon } from './icons.js'
import { CellEmpty } from './cell-empty.js'
import { sendsOnEnter } from './enter-key.js'
import { t } from './i18n.js'
import { useDockHold } from './card-hold.js'
import { SPRING_SHAPE, reducedEffects, reducedMotion, useMorph } from './motion.js'
import { createSource, heldCardKey } from './sources.js'

// -------------------------------------------------------------------------
// Question cards. `ask_user` cards sit in the transcript and never block the Bot;
// typing in the composer instead answers them. The blocking ask_user_question tool
// keeps the shell's composer takeover and gains an own-answer field.

export const keyLetter = index => String.fromCharCode(65 + index)
const optionsOf = question => (question?.options ?? []).map(option => (typeof option === 'string' ? { label: option } : option))
const isTypingTarget = node => node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement
  || node instanceof HTMLSelectElement || (node instanceof HTMLElement && node.isContentEditable)

// A bare letter picks that option and the letter after the last one
// jumps to the custom answer; never while typing or while a dialog is open.
// The listener is document-wide, so two open cards with letter keys would both
// answer the same key: each card registers here and the keys fire only while it
// is the sole registered card. The count also drives the key hints.
const optionKeyCards = createSource(0)
export function useOptionKeys(count, onPick, ownRef) {
  const pick = useRef(onPick)
  pick.current = onPick
  const listening = useSyncExternalStore(optionKeyCards.subscribe, optionKeyCards.getSnapshot)
  useEffect(() => {
    if (count === 0) return undefined
    optionKeyCards.set(value => value + 1)
    const onKey = (event) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.key.length !== 1) return
      if (isTypingTarget(event.target) || isTypingTarget(document.activeElement)) return
      if (document.querySelector('[role="dialog"], [aria-modal="true"]') !== null) return
      if (optionKeyCards.getSnapshot() !== 1) return
      const index = event.key.toUpperCase().charCodeAt(0) - 65
      if (index >= 0 && index < count) {
        event.preventDefault()
        pick.current(index)
      } else if (index === count && ownRef.current) {
        event.preventDefault()
        ownRef.current.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      optionKeyCards.set(value => value - 1)
    }
  }, [count, ownRef])
  // Before the effect runs the card is not counted yet; read that as alone so a
  // lone card's hints never flicker on mount.
  return count > 0 && listening <= 1
}

// A question shows two ways: as a bubble in the transcript, and raised when it
// sits in the dock above the composer.
function QuestionView({ question, onAnswer, onDismiss, onInteract, busy = false, ownAnswer = false, raised = false, enterToSend = true }) {
  const [own, setOwn] = useState('')
  const [picked, setPicked] = useState([])
  const ownRef = useRef(null)
  const titleId = useId()
  const options = optionsOf(question)
  const multi = question.multiSelect === true
  const custom = own.trim()
  const canSubmit = multi ? picked.length > 0 || custom !== '' : custom !== ''
  const choose = (label) => {
    if (busy) return
    onInteract?.()
    if (multi) {
      setPicked(current => current.includes(label) ? current.filter(item => item !== label) : [...current, label])
      return
    }
    onAnswer({ selected: [label] })
  }
  const submit = () => {
    if (!canSubmit || busy) return
    onInteract?.()
    onAnswer({ selected: multi ? picked : [], ...(custom ? { custom } : {}) })
  }
  const hints = useOptionKeys(busy ? 0 : options.length, index => choose(options[index].label), ownRef)
  const ownLetter = options.length > 0 ? keyLetter(options.length) : undefined
  const field = ownAnswer ? h('textarea', {
    ref: ownRef, rows: 1, value: own, readOnly: busy, autoComplete: 'off', spellCheck: false, className: 'bt-q-input',
    'aria-label': t('Your own answer'), placeholder: t('Type your own answer'),
    'aria-keyshortcuts': hints ? ownLetter?.toLowerCase() : undefined,
    onChange: (event) => { if (!busy) { onInteract?.(); setOwn(event.target.value) } },
    onKeyDown: (event) => {
      if (event.key !== 'Enter' || !enterToSend || event.shiftKey || event.nativeEvent.isComposing) return
      event.preventDefault()
      submit()
    },
  }) : null
  const rows = options.map((option, optionIndex) => {
    const selected = multi && picked.includes(option.label)
    return h('button', {
      key: option.label, type: 'button', className: 'bt-q-opt', disabled: busy,
      'aria-pressed': multi ? selected : undefined,
      'aria-keyshortcuts': hints ? keyLetter(optionIndex).toLowerCase() : undefined,
      onClick: () => choose(option.label),
    },
    hints ? h('span', { className: 'bt-key', 'aria-hidden': true }, keyLetter(optionIndex)) : null,
    h('span', { className: 'bt-q-body' },
      h('span', { className: 'bt-q-label' }, option.label),
      option.description ? h('span', { className: 'bt-q-desc' }, option.description) : null),
    selected && !raised ? h('span', { className: 'bt-q-check', title: t('Selected') }, h(CheckIcon)) : null)
  })
  // Raised cards keep the custom answer as one more keyed row; bubbles put it below the list.
  if (raised && field) {
    rows.push(h('label', { key: 'own', className: 'bt-q-opt bt-q-ownrow', 'data-filled': custom !== '' ? '' : undefined },
      hints && ownLetter ? h('span', { className: 'bt-key', 'aria-hidden': true }, ownLetter) : null,
      h('span', { className: 'bt-q-body' }, field)))
  }
  let foot = null
  if (raised && multi) {
    foot = h('div', { className: 'bt-q-foot' },
      h('button', { type: 'button', className: 'bt-q-btn', onClick: onDismiss, disabled: busy }, t('Skip')),
      h('button', { type: 'submit', className: 'bt-q-submit', disabled: !canSubmit || busy }, t('Submit')))
  } else if ((raised || multi) && canSubmit) {
    foot = h('div', { className: 'bt-q-foot' }, h('button', { type: 'submit', className: 'bt-q-submit', disabled: busy }, t('Submit')))
  }
  return h('form', {
    className: raised ? 'bt-q bt-q-raised' : 'bt-q', 'aria-labelledby': titleId,
    'aria-busy': busy || undefined,
    onFocusCapture: onInteract, onPointerDownCapture: onInteract,
    onSubmit: (event) => { event.preventDefault(); submit() },
  },
    h('div', { className: 'bt-q-head' },
      h('div', { className: 'bt-q-text' },
        h('p', { className: 'bt-q-title', id: titleId }, question.header ? `${question.header} · ` : '', question.question),
        question.detail ? h('div', { className: 'bt-q-detail' }, question.detail) : null,
        raised && multi ? h('div', { className: 'bt-q-detail' }, t('Choose all that apply')) : null),
      h('button', { type: 'button', className: 'bt-q-x', 'aria-label': t('Dismiss question'), title: t('Dismiss'), onClick: onDismiss, disabled: busy }, h(CloseIcon))),
    rows.length > 0 ? h('div', { className: 'bt-q-list', role: 'group' }, rows) : null,
    field && !raised ? h('div', { className: 'bt-q-custom' },
      h('label', { className: 'bt-q-field' }, field),
      !multi && canSubmit ? h('button', { type: 'submit', className: 'bt-q-submit', disabled: busy }, t('Submit')) : null) : null,
    foot)
}

// How a card closed without an answer on it reads on its badge.
export const closedLabel = closed => t(closed === 'replied' ? 'Answered by message' : 'Dismissed')

// Carries the pending card's height across unmount when an inline answer lands on a
// separate reply node, so a freshly answered card shrinks smoothly into its folded form
// while historical cards loaded later open at rest without animating.
const JUST_ANSWERED_TTL = 2000
const justAnswered = new Map()
const answerKey = (kind, id) => `${kind}:${id}`

export function noteJustAnswered(kind, id, height) {
  if (!id || typeof height !== 'number' || height <= 0) return
  const now = Date.now()
  for (const [key, entry] of justAnswered) {
    if (now - entry.at >= JUST_ANSWERED_TTL) justAnswered.delete(key)
  }
  justAnswered.set(answerKey(kind, id), { height, at: now })
}

export function clearJustAnswered(kind, id) {
  if (id) justAnswered.delete(answerKey(kind, id))
}

export function takeJustAnswered(kind, id) {
  if (!id) return undefined
  const key = answerKey(kind, id)
  const entry = justAnswered.get(key)
  justAnswered.delete(key)
  if (!entry || Date.now() - entry.at >= JUST_ANSWERED_TTL) return undefined
  return entry.height
}

// Plays one SPRING_SHAPE height transition on first mount if a pending card with the
// same id was just answered inline in this turn.
export function useAnswerMorph(cardRef, kind, id) {
  useLayoutEffect(() => {
    const from = takeJustAnswered(kind, id)
    const node = cardRef.current
    if (from === undefined || !node || reducedEffects() || typeof node.animate !== 'function') return undefined
    const to = node.offsetHeight
    if (Math.abs(from - to) < 1) return undefined
    node.dataset.morph = ''
    const animation = node.animate([{ height: `${from}px` }, { height: `${to}px` }], {
      duration: SPRING_SHAPE.duration, easing: SPRING_SHAPE.easing, id: 'bt-morph',
    })
    const clear = () => {
      if (!node.getAnimations?.()?.some(other => other.id === 'bt-morph' && other !== animation)) delete node.dataset.morph
    }
    animation.onfinish = clear
    animation.oncancel = clear
    return () => animation.cancel()
  }, [])
}

// Expand/collapse controller shared by settled question and view cards: smoothly morphs
// height on SPRING_SHAPE and lingers the leaving body out-of-flow during collapse so the
// card neither snaps to zero nor shifts when it unmounts.
export function useFoldCard(cardRef, bodyRef, hasDetail) {
  const [open, setOpen] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const foldTopRef = useRef(44)
  useMorph(cardRef, open)
  useLayoutEffect(() => {
    if (open && bodyRef.current) foldTopRef.current = bodyRef.current.offsetTop
  }, [open, hasDetail])
  useEffect(() => {
    if (open || !leaving) return undefined
    if (reducedMotion() || typeof setTimeout !== 'function') { setLeaving(false); return undefined }
    const timer = setTimeout(() => setLeaving(false), 150)
    return () => clearTimeout(timer)
  }, [open, leaving])
  const toggle = () => {
    if (!hasDetail) return
    if (open && bodyRef.current) foldTopRef.current = bodyRef.current.offsetTop
    if (open && !reducedMotion() && typeof setTimeout === 'function') setLeaving(true)
    else setLeaving(false)
    setOpen(value => !value)
  }
  const onCardClick = (event) => {
    if (open || !hasDetail) return
    if (typeof window !== 'undefined' && window.getSelection?.()?.toString()) return
    if (event?.target?.closest?.('button, a, input, textarea, select, label')) return
    setLeaving(false)
    setOpen(true)
  }
  return {
    open,
    showBody: (open || leaving) && hasDetail,
    leaving: !open && leaving && hasDetail,
    foldTop: foldTopRef.current,
    toggle,
    onCardClick,
  }
}

// The settled card left in the transcript, read-only and compact: the question,
// muted, and only what the user chose, each under the letter it had on the card;
// an own answer takes the letter after the options. A card closed without an
// answer (`closed`, or no answer) keeps only the question and a badge. Cards with
// hidden detail or unchosen options expand smoothly on demand.
export function SettledQuestion({ question, answer, closed }) {
  const options = optionsOf(question)
  const prompt = question?.question || question?.header || ''
  const detail = typeof question?.detail === 'string' ? question.detail.trim() : ''
  const selected = Array.isArray(answer?.selected) ? answer.selected : []
  const custom = typeof answer?.custom === 'string' ? answer.custom.trim() : ''
  const answered = closed === undefined && (selected.length > 0 || custom !== '')
  const chosen = answered ? [
    ...selected.map(label => ({ label, at: options.findIndex(option => option.label === label) })),
    ...(custom !== '' ? [{ label: custom, at: options.length }] : []),
  ] : []
  const hasDetail = detail !== '' || (answered
    ? options.some(option => (typeof option?.description === 'string' && option.description.trim() !== '') || !selected.includes(option.label))
    : options.length > 0)
  const cardRef = useRef(null)
  const bodyRef = useRef(null)
  useAnswerMorph(cardRef, 'question', question?.id)
  const fold = useFoldCard(cardRef, bodyRef, hasDetail)
  const badge = answered ? null : h('span', { className: 'bt-q-badge' }, closedLabel(closed))
  const head = hasDetail
    ? h('button', {
      type: 'button', className: 'bt-q-head bt-q-fold',
      'aria-expanded': fold.open, title: fold.open ? t('Show less') : t('Show more'), onClick: fold.toggle,
    },
    h('span', { className: 'bt-q-text' }, prompt ? h('span', { className: 'bt-q-title' }, prompt) : null),
    badge,
    h('span', { className: 'bt-q-chevron', 'aria-hidden': true }, h(ChevronDownIcon)))
    : h('div', { className: 'bt-q-head' },
      h('div', { className: 'bt-q-text' }, prompt ? h('p', { className: 'bt-q-title' }, prompt) : null),
      badge)
  return h('div', {
    ref: cardRef,
    className: answered ? 'bt-q bt-q-settled bt-q-answered' : 'bt-q bt-q-settled bt-q-dismissed',
    'data-open': fold.open ? '' : undefined,
    'data-expandable': hasDetail ? '' : undefined,
    role: 'group',
    'aria-label': prompt,
    onClick: hasDetail && !fold.open ? fold.onCardClick : undefined,
  },
  head,
  !fold.open && chosen.length > 0 ? h('div', { className: 'bt-q-list bt-q-summary', role: 'group', 'aria-label': t('Your answer') }, chosen.map(({ label, at }, index) =>
    h('div', { key: `${label}-${index}`, className: 'bt-q-opt', title: t('Selected') },
      at >= 0 ? h('span', { className: 'bt-key', 'aria-hidden': true }, keyLetter(at)) : null,
      h('span', { className: 'bt-q-body' }, h('span', { className: 'bt-q-label' }, label))))) : null,
  fold.showBody ? h('div', {
    ref: bodyRef,
    className: 'bt-q-expand',
    'data-leaving': fold.leaving ? '' : undefined,
    style: fold.leaving ? { '--bt-fold-top': `${fold.foldTop}px` } : undefined,
  },
  detail !== '' ? h('div', { className: 'bt-q-detail' }, detail) : null,
  options.length > 0 || (answered && custom !== '')
    ? h('div', { className: 'bt-q-list bt-q-full-list', role: 'group', 'aria-label': answered ? t('Your answer') : undefined },
      options.map((option, optionIndex) => {
        const picked = answered && selected.includes(option.label)
        return h('div', {
          key: `${option.label}-${optionIndex}`,
          className: 'bt-q-opt',
          'data-chosen': picked ? '' : undefined,
          title: picked ? t('Selected') : undefined,
        },
        h('span', { className: 'bt-key', 'aria-hidden': true }, keyLetter(optionIndex)),
        h('span', { className: 'bt-q-body' },
          h('span', { className: 'bt-q-label' }, option.label),
          option.description ? h('span', { className: 'bt-q-desc' }, option.description) : null),
        picked ? h('span', { className: 'bt-q-check', title: t('Selected') }, h(CheckIcon)) : null)
      }),
      answered && custom !== '' ? h('div', {
        key: 'own',
        className: 'bt-q-opt',
        'data-chosen': '',
        title: t('Selected'),
      },
      h('span', { className: 'bt-key', 'aria-hidden': true }, keyLetter(options.length)),
      h('span', { className: 'bt-q-body' }, h('span', { className: 'bt-q-label' }, custom)),
      h('span', { className: 'bt-q-check', title: t('Selected') }, h(CheckIcon))) : null)
    : null) : null)
}

export function QuestionCard({ matched }) {
  const pending = matched
  const questions = pending.questions ?? []
  const [index, setIndex] = useState(0)
  const [answers, setAnswers] = useState([])
  const question = questions[index]
  if (question === undefined) return null
  const onAnswer = (answer) => {
    const next = [...answers, { id: question.id, ...answer }]
    if (index + 1 < questions.length) {
      setAnswers(next)
      setIndex(index + 1)
      return
    }
    pending.answer({ answers: next })
  }
  return h(QuestionView, { key: index, question, onAnswer, onDismiss: () => pending.dismiss(), ownAnswer: true, raised: true })
}

export function PendingQuestion({ sessionId, question, actions, inline, enterToSend = true, bare = false }) {
  const [answered, setAnswered] = useState(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const boxRef = useRef(null)
  const hold = useDockHold(sessionId, 'question', question.id, actions, inline)
  if (answered === question.id) return h(CellEmpty)
  const run = (make, { settle = false, onFail } = {}) => {
    if (busyRef.current) return
    hold()
    busyRef.current = true
    setBusy(true)
    // Keep QuestionView mounted until success: a failed request must not erase
    // the selected options, custom answer, or focused field. On dismiss, wait for
    // roster to swap to the folded settled card in place rather than collapsing to 0.
    void Promise.resolve().then(make).then(() => { if (settle) setAnswered(question.id) }, () => {
      onFail?.()
      setAnswered(null)
    }).finally(() => {
      busyRef.current = false
      setBusy(false)
    })
  }
  const onAnswer = (answer) => {
    if (busyRef.current) return
    const height = boxRef.current?.firstElementChild?.offsetHeight || boxRef.current?.offsetHeight
    if (inline) noteJustAnswered('question', question.id, height)
    run(() => actions.answerQuestion(sessionId, question.id, { selected: answer.selected ?? [], custom: answer.custom ?? '' }), {
      settle: true,
      onFail: () => clearJustAnswered('question', question.id),
    })
  }
  const onDismiss = () => run(() => actions.dismissQuestion(sessionId))
  return h('div', { ref: boxRef, className: bare ? 'bt-q-hold' : (inline ? 'bt-q-inline' : 'bt-q-dock') },
    h(QuestionView, { key: question.id, question, onAnswer, onDismiss, onInteract: hold, busy, ownAnswer: question.allowCustom === true, raised: !inline, enterToSend }))
}

// Inline ask_user call in the transcript: keeps a single wrapper across pending and
// message/dismissed states so settling folds smoothly on SPRING_SHAPE.
export function AskUserCell({ sessionId, callId, arg, argValue, roster, actions, heldCards }) {
  const question = roster.questions?.[sessionId]
  const isPending = Boolean(question) && (question.callSessionId ?? sessionId) === sessionId && question.callId === callId
  const held = isPending && heldCards?.[heldCardKey('question', question.id)] > 0
  const closed = !isPending && callId !== undefined ? roster.closedCards?.[sessionId]?.[callId] : undefined
  const cellRef = useRef(null)
  const phase = held ? 'held' : isPending ? `pending:${question.id}` : closed !== undefined ? `closed:${closed}` : 'gone'
  useMorph(cellRef, phase)
  if (held) return h(CellEmpty)
  if (isPending) {
    return h('div', { ref: cellRef, className: 'bt-q-inline' },
      h(PendingQuestion, { key: JSON.stringify([sessionId, question.id]), sessionId, question, actions, inline: true, enterToSend: sendsOnEnter(roster.prefs), bare: true }))
  }
  if (closed === undefined) return h(CellEmpty, { className: 'bt-q-gone' })
  const asked = { question: arg('question') ?? '', detail: arg('detail'), options: argValue('options') ?? [], multiSelect: argValue('multiSelect') === true }
  return h('div', { ref: cellRef, className: 'bt-q-inline' }, h(SettledQuestion, { question: asked, closed }))
}

// Questions asked by a tool call render inline at that call (see ToolCell); the dock
// carries the ones whose call the transcript does not draw, including while history
// loads. A card the user starts editing stays in the dock until it closes.
export function QuestionDock({ sessionId, useRoster, useCards, useHeldCards, actions }) {
  const question = useRoster(value => value.questions?.[sessionId])
  const enterToSend = useRoster(value => sendsOnEnter(value.prefs))
  const drawn = useCards?.(state => state[sessionId]?.[question?.callId] > 0) === true
  const held = useHeldCards?.(state => state[sessionId]?.[heldCardKey('question', question?.id)] > 0) === true
  const inPart = (question?.callSessionId ?? sessionId) === sessionId
  const handedOff = inPart && Boolean(question?.callId) && drawn && !held
  const visible = question !== undefined && !handedOff
  const [exiting, setExiting] = useState(null)
  const prevRef = useRef({ sessionId, question: undefined, handedOff: false })
  useEffect(() => {
    const prev = prevRef.current
    prevRef.current = { sessionId, question, handedOff }
    if (visible) {
      if (exiting) setExiting(null)
      return undefined
    }
    if (prev.sessionId === sessionId && prev.question !== undefined && !prev.handedOff && question === undefined && !reducedMotion() && typeof setTimeout === 'function') {
      setExiting(prev.question)
      const timer = setTimeout(() => setExiting(null), 150)
      return () => clearTimeout(timer)
    }
    if (exiting) setExiting(null)
    return undefined
  }, [sessionId, question?.id, visible])
  if (!visible) {
    if (question === undefined && exiting) {
      return h('div', { className: 'bt-q-dock', 'data-leaving': '' },
        h(QuestionView, { key: exiting.id, question: exiting, busy: true, ownAnswer: exiting.allowCustom === true, raised: true, enterToSend }))
    }
    return null
  }
  return h(PendingQuestion, { key: JSON.stringify([sessionId, question.id]), sessionId, question, actions, inline: false, enterToSend })
}

// An answered card in the transcript: the question stays where it was asked, with the
// answer marked.
export function AnsweredCell({ node }) {
  const data = node.data ?? {}
  // The reply text is ds-bot's own payload and keeps each question's options; the
  // pairs DSH reads out of it may drop them.
  let sent = null
  try { sent = typeof data.text === 'string' ? JSON.parse(data.text) : null } catch { sent = null }
  const asked = Array.isArray(sent?.questions) ? sent.questions.filter(item => typeof item?.id === 'string' && typeof item.question === 'string') : []
  const questions = (Array.isArray(data.questions) ? data.questions : []).map(question => ({ ...asked.find(item => item.id === question.id), ...question }))
  if (questions.length === 0) {
    return data.text ? h('div', { className: 'bt-urow' }, h('div', { className: 'bt-ububble' }, data.text)) : h(CellEmpty)
  }
  const answers = Array.isArray(data.answers) ? data.answers : []
  return h('div', { className: 'bt-q-inline' }, questions.map(question => h(SettledQuestion, {
    key: question.id,
    question,
    answer: answers.find(answer => answer.id === question.id) ?? { selected: [] },
  })))
}
