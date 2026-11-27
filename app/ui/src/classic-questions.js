// Classic Agent DSH `ask_user_question` and `exit_plan_mode` review docks above the composer.
// Reuses DS Bot's `.bt-q` / `.bt-q-raised` / `.bt-key` card language so Bot and Classic
// interactive prompts look and feel like one cohesive interface.
import { createElement as h, Fragment, useEffect, useId, useMemo, useRef, useState } from 'react'
import { MarkdownText, writeClipboard } from '../../../ds-bot/src/client/dsh-primitives.js'
import { isImeComposing, sendsOnEnter } from '../../../ds-bot/src/client/enter-key.js'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { CheckIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, ChevronUpIcon, CloseIcon, CopyIcon } from '../../../ds-bot/src/client/icons.js'
import { useEscape } from '../../../ds-bot/src/client/overlay-hooks.js'
import { keyLetter, useOptionKeys } from '../../../ds-bot/src/client/questions.js'
import { PlanModeIcon } from './classic-controls.js'

const RECOMMENDED_SUFFIX = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/iu
const HEADING_RE = /^#{1,6}\s+(.+?)\s*$/m
const LEADING_H1_RE = /^\s*#\s+(.+?)\s*(?:\r?\n|$)/

export function parseRecommendedLabel(rawLabel) {
  const label = String(rawLabel ?? '')
  return RECOMMENDED_SUFFIX.test(label)
    ? { label: label.replace(RECOMMENDED_SUFFIX, ''), recommended: true }
    : { label, recommended: false }
}

export function extractPlanHeading(markdown) {
  if (typeof markdown !== 'string') return ''
  const match = HEADING_RE.exec(markdown)
  return match?.[1]?.trim() ?? ''
}

// Strip the leading `# Heading` when it matches the header title so Plan cards
// never display the exact same title twice in a row.
export function stripPlanHeading(markdown, heading) {
  if (typeof markdown !== 'string') return ''
  const trimmed = markdown.trim()
  if (trimmed === '') return ''
  const match = LEADING_H1_RE.exec(trimmed)
  if (!match) return trimmed
  const firstTitle = match[1]?.trim() ?? ''
  if (heading && firstTitle !== heading) return trimmed
  return trimmed.slice(match[0].length).replace(/^\s+/, '')
}

function emptyDraftFor(question) {
  return {
    id: question.id,
    selected: [],
    custom: '',
    skipped: false,
  }
}

function isDraftAnswered(draft) {
  return draft.skipped === true || draft.selected.length > 0 || draft.custom.trim() !== ''
}

function buildAnswerPayload(drafts) {
  return drafts.map((draft) => {
    if (draft.skipped) return { id: draft.id, selected: [] }
    const custom = draft.custom.trim()
    return {
      id: draft.id,
      selected: [...draft.selected],
      ...(custom !== '' ? { custom } : {}),
    }
  })
}

function formatCountdown(ms) {
  const secs = Math.max(0, Math.ceil(ms / 1000))
  const mins = Math.floor(secs / 60)
  const rem = secs % 60
  return mins > 0 ? `${mins}:${String(rem).padStart(2, '0')}` : `${secs}s`
}

function ClassicQuestionCard({ entry, enterToSend, readOnly, actions }) {
  const questions = entry.questions ?? []
  const total = questions.length
  const stableKey = entry.callId ?? entry.id
  const [index, setIndex] = useState(0)
  const [drafts, setDrafts] = useState(() => questions.map(emptyDraftFor))
  const [minimized, setMinimized] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [remainingMs, setRemainingMs] = useState(() => (
    entry.mode === 'blocking' && Number.isFinite(entry.deadlineAt)
      ? Math.max(0, entry.deadlineAt - Date.now())
      : null
  ))
  const ownRef = useRef(null)
  const titleId = useId()

  // Reset in-progress answers only when a genuinely different question arrives (`callId ?? id`),
  // never when a timed question transitions from blocking `<uuid>` to `continued:<callId>`.
  useEffect(() => {
    setIndex(0)
    setDrafts(questions.map(emptyDraftFor))
    setMinimized(false)
    setBusy(false)
    setError('')
  }, [stableKey])

  useEffect(() => {
    if (entry.mode !== 'blocking' || !Number.isFinite(entry.deadlineAt)) {
      setRemainingMs(null)
      return undefined
    }
    const update = () => setRemainingMs(Math.max(0, entry.deadlineAt - Date.now()))
    update()
    const timer = setInterval(update, 1000)
    return () => clearInterval(timer)
  }, [entry.mode, entry.deadlineAt])

  const safeIndex = Math.max(0, Math.min(index, Math.max(0, total - 1)))
  const question = questions[safeIndex]
  const draft = drafts[safeIndex] ?? (question ? emptyDraftFor(question) : null)

  const updateDraft = (at, updater) => {
    setDrafts(prev => prev.map((item, idx) => (idx === at ? updater(item) : item)))
    setError('')
  }

  const submitDrafts = async (nextDrafts) => {
    if (busy || readOnly) return
    setBusy(true)
    setError('')
    try {
      await actions.answerUserQuestion(entry.sessionId, entry.id, buildAnswerPayload(nextDrafts))
    } catch (failure) {
      setError(failure?.message ?? t('Couldn’t submit answer'))
      setBusy(false)
    }
  }

  const dismiss = async () => {
    if (busy || readOnly) return
    if (entry.mode === 'continued') {
      setMinimized(true)
      return
    }
    setBusy(true)
    setError('')
    try {
      await actions.dismissUserQuestion(entry.sessionId, entry.id)
    } catch (failure) {
      setError(failure?.message ?? t('Couldn’t dismiss question'))
      setBusy(false)
    }
  }

  const options = question?.options ?? []
  const multi = question?.multiSelect === true

  const chooseOption = (rawLabel) => {
    if (!question || busy || readOnly) return
    if (multi) {
      updateDraft(safeIndex, cur => {
        const has = cur.selected.includes(rawLabel)
        return {
          ...cur,
          skipped: false,
          selected: has ? cur.selected.filter(x => x !== rawLabel) : [...cur.selected, rawLabel],
        }
      })
      return
    }
    // Single-select: clear custom text and select this option.
    const nextDrafts = drafts.map((item, idx) => (idx === safeIndex
      ? { ...item, selected: [rawLabel], custom: '', skipped: false }
      : item))
    setDrafts(nextDrafts)
    setError('')
    if (total === 1) {
      void submitDrafts(nextDrafts)
      return
    }
    const nextUnanswered = nextDrafts.findIndex((item, idx) => idx > safeIndex && !isDraftAnswered(item))
    if (nextUnanswered >= 0) setIndex(nextUnanswered)
    else if (safeIndex < total - 1) setIndex(safeIndex + 1)
  }

  const skipCurrent = () => {
    if (!question || busy || readOnly) return
    const nextDrafts = drafts.map((item, idx) => (idx === safeIndex
      ? { id: item.id, selected: [], custom: '', skipped: true }
      : item))
    setDrafts(nextDrafts)
    setError('')
    if (total === 1) {
      void submitDrafts(nextDrafts)
      return
    }
    if (safeIndex < total - 1) {
      setIndex(safeIndex + 1)
    } else if (nextDrafts.every(isDraftAnswered)) {
      void submitDrafts(nextDrafts)
    }
  }

  const hints = useOptionKeys(
    minimized || busy || readOnly ? 0 : options.length,
    optionIdx => { if (options[optionIdx]) chooseOption(options[optionIdx].label) },
    ownRef,
  )

  if (!question || !draft) return null

  const answeredCount = drafts.filter(isDraftAnswered).length
  const allReady = drafts.every(isDraftAnswered)
  const currentReady = isDraftAnswered(draft)
  const ownLetter = options.length > 0 ? keyLetter(options.length) : undefined

  const handleCustomSubmit = () => {
    if (busy || readOnly) return
    if (total === 1) {
      if (currentReady) void submitDrafts(drafts)
      return
    }
    if (allReady) {
      void submitDrafts(drafts)
    } else if (safeIndex < total - 1) {
      setIndex(safeIndex + 1)
    } else {
      const firstOpen = drafts.findIndex(item => !isDraftAnswered(item))
      if (firstOpen >= 0) setIndex(firstOpen)
    }
  }

  if (minimized) {
    return h('div', { className: 'bt-q bt-q-raised dsb-cq-mini', 'data-classic-question': '' },
      h('div', { className: 'dsb-cq-mini-bar' },
        h('span', { className: 'dsb-cq-mini-title' }, question.header ? `${question.header} · ${question.question}` : question.question),
        total > 1 ? h('span', { className: 'bt-q-badge' }, `${answeredCount}/${total}`) : null,
        h('button', {
          type: 'button',
          className: 'bt-q-btn dsb-cq-mini-btn',
          onClick: () => setMinimized(false),
        }, t('Expand'))))
  }

  return h('form', {
    className: 'bt-q bt-q-raised dsb-cq',
    'data-classic-question': '',
    'aria-labelledby': titleId,
    'aria-busy': busy || undefined,
    onSubmit: (event) => {
      event.preventDefault()
      handleCustomSubmit()
    },
  },
  h('div', { className: 'bt-q-head' },
    h('div', { className: 'bt-q-text' },
      total > 1 ? h('div', { className: 'dsb-cq-pager' },
        h('span', { className: 'dsb-cq-step' }, t('Question {current} of {total}', { current: safeIndex + 1, total })),
        h('div', { className: 'dsb-cq-nav' },
          h('button', {
            type: 'button',
            className: 'dsb-cq-nav-btn',
            disabled: safeIndex === 0 || busy,
            'aria-label': t('Previous question'),
            title: t('Previous question'),
            onClick: () => setIndex(Math.max(0, safeIndex - 1)),
          }, h(ChevronLeftIcon)),
          h('button', {
            type: 'button',
            className: 'dsb-cq-nav-btn',
            disabled: safeIndex >= total - 1 || busy,
            'aria-label': t('Next question'),
            title: t('Next question'),
            onClick: () => setIndex(Math.min(total - 1, safeIndex + 1)),
          }, h(ChevronRightIcon)))) : null,
      h('p', { className: 'bt-q-title', id: titleId }, question.header ? `${question.header} · ` : '', question.question),
      question.detail ? h('div', { className: 'bt-q-detail' }, question.detail) : null,
      multi ? h('div', { className: 'bt-q-detail' }, t('Choose all that apply')) : null),
    h('div', { className: 'dsb-cq-head-acts' },
      remainingMs !== null ? h('span', { className: 'dsb-cq-timer', 'aria-live': 'off' }, formatCountdown(remainingMs)) : null,
      h('button', {
        type: 'button',
        className: 'bt-q-x',
        'aria-label': t('Minimize'),
        title: t('Minimize'),
        disabled: busy,
        onClick: () => setMinimized(true),
      }, h(ChevronDownIcon)),
      entry.mode !== 'continued' ? h('button', {
        type: 'button',
        className: 'bt-q-x',
        'aria-label': t('Dismiss question'),
        title: t('Dismiss'),
        disabled: busy || readOnly,
        onClick: () => { void dismiss() },
      }, h(CloseIcon)) : null)),
  h('div', { className: 'bt-q-list', role: 'group' },
    options.map((option, optionIndex) => {
      const parsed = parseRecommendedLabel(option.label)
      const selected = draft.selected.includes(option.label)
      return h('button', {
        key: `${option.label}:${optionIndex}`,
        type: 'button',
        className: 'bt-q-opt',
        disabled: busy || readOnly,
        'aria-pressed': selected,
        'aria-keyshortcuts': hints ? keyLetter(optionIndex).toLowerCase() : undefined,
        onClick: () => chooseOption(option.label),
      },
      hints ? h('span', { className: 'bt-key', 'aria-hidden': true }, keyLetter(optionIndex)) : null,
      h('span', { className: 'bt-q-body' },
        h('span', { className: 'bt-q-label dsb-cq-opt-head' },
          h('span', null, parsed.label),
          parsed.recommended ? h('span', { className: 'dsb-cq-rec' }, t('Recommended')) : null),
        option.description ? h('span', { className: 'bt-q-desc' }, option.description) : null),
      selected ? h('span', { className: 'bt-q-check', title: t('Selected') }, h(CheckIcon)) : null)
    }),
    h('label', {
      key: 'own',
      className: options.length > 0 ? 'bt-q-opt bt-q-ownrow' : 'dsb-cq-free',
      'data-filled': draft.custom.trim() !== '' ? '' : undefined,
    },
    options.length > 0 && hints && ownLetter ? h('span', { className: 'bt-key', 'aria-hidden': true }, ownLetter) : null,
    h('span', { className: 'bt-q-body' },
      h('textarea', {
        ref: ownRef,
        rows: 1,
        value: draft.custom,
        readOnly: busy || readOnly,
        disabled: readOnly,
        autoComplete: 'off',
        spellCheck: false,
        className: 'bt-q-input',
        'aria-label': t('Your own answer'),
        placeholder: t('Type your own answer'),
        'aria-keyshortcuts': options.length > 0 && hints ? ownLetter?.toLowerCase() : undefined,
        onChange: (event) => {
          if (busy || readOnly) return
          const value = event.target.value
          updateDraft(safeIndex, cur => ({
            ...cur,
            skipped: false,
            custom: value,
            selected: !multi && value.trim() !== '' ? [] : cur.selected,
          }))
        },
        onKeyDown: (event) => {
          if (event.key !== 'Enter' || event.shiftKey || isImeComposing(event)) return
          const modEnter = event.metaKey || event.ctrlKey
          if (!enterToSend && !modEnter) return
          event.preventDefault()
          handleCustomSubmit()
        },
      })))),
  error ? h('p', { className: 'dsb-cq-error', role: 'alert' }, error) : null,
  h('div', { className: 'bt-q-foot dsb-cq-foot' },
    draft.skipped ? h('span', { className: 'bt-q-badge' }, t('Skipped')) : null,
    h('div', { className: 'dsb-cq-foot-acts' },
      h('button', {
        type: 'button',
        className: 'bt-q-btn',
        disabled: busy || readOnly,
        onClick: skipCurrent,
      }, t('Skip')),
      total > 1 && safeIndex < total - 1 && !allReady
        ? h('button', {
          type: 'button',
          className: 'bt-q-submit',
          disabled: !currentReady || busy || readOnly,
          onClick: () => setIndex(safeIndex + 1),
        }, t('Next question'))
        : h('button', {
          type: 'submit',
          className: 'bt-q-submit',
          disabled: (total > 1 ? !allReady : !currentReady) || busy || readOnly,
        }, total > 1 ? t('Submit ({answered}/{total})', { answered: answeredCount, total }) : t('Submit')))))
}

export function ClassicQuestionDock({ sessionId, useUserQuestions, useRoster, actions, readOnly = false }) {
  const list = useUserQuestions?.(items => (Array.isArray(items) ? items : [])) ?? []
  const enterToSend = useRoster(state => sendsOnEnter(state.prefs))
  const entry = useMemo(
    () => list.find(item => item?.sessionId === sessionId && item.kind !== 'plan-review'),
    [list, sessionId],
  )
  if (!entry) return null
  return h(ClassicQuestionCard, { key: entry.callId ?? entry.id, entry, enterToSend, readOnly, actions })
}

function ClassicPlanReviewCard({ entry, enterToSend, readOnly, actions }) {
  const question = entry.questions?.[0]
  const planMarkdown = question?.detail ?? ''
  const title = extractPlanHeading(planMarkdown) || t('Plan review')
  const bodyMarkdown = stripPlanHeading(planMarkdown, title)
  const approveLabel = question?.intent?.approve ?? question?.options?.[0]?.label ?? 'Approve'
  const keepLabel = question?.options?.find(opt => opt.label !== approveLabel)?.label ?? 'Keep planning'
  const stableKey = entry.callId ?? entry.id

  const [expanded, setExpanded] = useState(false)
  const [askingChanges, setAskingChanges] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const feedbackRef = useRef(null)
  const titleId = useId()

  useEffect(() => {
    setExpanded(false)
    setAskingChanges(false)
    setFeedback('')
    setCopied(false)
    setBusy(false)
    setError('')
  }, [stableKey])

  useEffect(() => {
    if (askingChanges) feedbackRef.current?.focus?.()
  }, [askingChanges])

  // Coordinate Escape through the shared overlay stack so cancelling feedback
  // never closes drawers or panels behind the plan card.
  useEscape(() => {
    if (!busy) {
      setAskingChanges(false)
      setError('')
    }
  }, askingChanges, { priority: 20 })

  if (!question) return null

  const approve = async () => {
    if (busy || readOnly) return
    setBusy(true)
    setError('')
    try {
      await actions.answerUserQuestion(entry.sessionId, entry.id, [{ id: question.id, selected: [approveLabel] }])
    } catch (failure) {
      setError(failure?.message ?? t('Couldn’t submit answer'))
      setBusy(false)
    }
  }

  const requestChanges = async () => {
    if (busy || readOnly) return
    const trimmed = feedback.trim()
    setBusy(true)
    setError('')
    try {
      await actions.answerUserQuestion(entry.sessionId, entry.id, [{
        id: question.id,
        selected: [keepLabel],
        ...(trimmed !== '' ? { custom: trimmed } : {}),
      }])
    } catch (failure) {
      setError(failure?.message ?? t('Couldn’t submit answer'))
      setBusy(false)
    }
  }

  const dismiss = async () => {
    if (busy || readOnly || entry.mode === 'continued') return
    setBusy(true)
    setError('')
    try {
      await actions.dismissUserQuestion(entry.sessionId, entry.id)
    } catch (failure) {
      setError(failure?.message ?? t('Couldn’t dismiss question'))
      setBusy(false)
    }
  }

  const copyPlan = async () => {
    const ok = await writeClipboard(planMarkdown)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    }
  }

  return h('section', {
    className: 'bt-q bt-q-raised dsb-plan-review',
    'data-plan-review': '',
    'aria-labelledby': titleId,
    'aria-busy': busy || undefined,
  },
  h('div', { className: 'dsb-plan-review-head' },
    h('span', { className: 'dsb-plan-review-ico', 'aria-hidden': true }, h(PlanModeIcon)),
    h('div', { className: 'dsb-plan-review-titles' },
      h('h3', { id: titleId, className: 'dsb-plan-review-title' }, title),
      h('span', { className: 'dsb-plan-badge', 'data-tone': 'pending' }, t('Pending review'))),
    h('div', { className: 'dsb-plan-review-tools' },
      planMarkdown ? h('button', {
        type: 'button',
        className: 'bt-q-x',
        'aria-label': copied ? t('Copied') : t('Copy plan'),
        title: copied ? t('Copied') : t('Copy plan'),
        onClick: () => { void copyPlan() },
      }, copied ? h(CheckIcon) : h(CopyIcon)) : null,
      bodyMarkdown ? h('button', {
        type: 'button',
        className: 'bt-q-x',
        'aria-label': expanded ? t('Collapse plan') : t('Show full plan'),
        title: expanded ? t('Collapse plan') : t('Show full plan'),
        'aria-expanded': expanded,
        onClick: () => setExpanded(value => !value),
      }, expanded ? h(ChevronUpIcon) : h(ChevronDownIcon)) : null,
      entry.mode !== 'continued' ? h('button', {
        type: 'button',
        className: 'bt-q-x',
        'aria-label': t('Dismiss'),
        title: t('Dismiss'),
        disabled: busy || readOnly,
        onClick: () => { void dismiss() },
      }, h(CloseIcon)) : null)),
  bodyMarkdown ? h('div', {
    className: 'dsb-plan-review-body',
    'data-expanded': expanded ? '' : undefined,
  }, h(MarkdownText, { text: bodyMarkdown })) : null,
  askingChanges ? h('div', { className: 'dsb-plan-feedback' },
    h('textarea', {
      ref: feedbackRef,
      rows: 2,
      value: feedback,
      disabled: busy || readOnly,
      className: 'dsb-plan-feedback-input',
      'aria-label': t('Describe the changes you want…'),
      placeholder: t('Describe the changes you want…'),
      onChange: event => { setFeedback(event.target.value); setError('') },
      onKeyDown: (event) => {
        if (event.key !== 'Enter' || event.shiftKey || isImeComposing(event)) return
        const modEnter = event.metaKey || event.ctrlKey
        if (!enterToSend && !modEnter) return
        event.preventDefault()
        void requestChanges()
      },
    })) : null,
  error ? h('p', { className: 'dsb-cq-error', role: 'alert' }, error) : null,
  h('div', { className: 'bt-q-foot dsb-plan-review-foot' },
    askingChanges
      ? h(Fragment, null,
        h('button', {
          type: 'button',
          className: 'bt-q-btn',
          disabled: busy,
          onClick: () => { setAskingChanges(false); setError('') },
        }, t('Cancel')),
        h('button', {
          type: 'button',
          className: 'bt-q-submit',
          disabled: busy || readOnly,
          onClick: () => { void requestChanges() },
        }, t('Send feedback')))
      : h(Fragment, null,
        h('button', {
          type: 'button',
          className: 'bt-q-btn',
          disabled: busy || readOnly,
          onClick: () => setAskingChanges(true),
        }, t('Ask for changes')),
        h('button', {
          type: 'button',
          className: 'bt-q-submit',
          disabled: busy || readOnly,
          onClick: () => { void approve() },
        }, t('Approve')))))
}

export function ClassicPlanReviewDock({ sessionId, useUserQuestions, useRoster, actions, readOnly = false }) {
  const list = useUserQuestions?.(items => (Array.isArray(items) ? items : [])) ?? []
  const enterToSend = useRoster(state => sendsOnEnter(state.prefs))
  const entry = useMemo(
    () => list.find(item => item?.sessionId === sessionId && item.kind === 'plan-review'),
    [list, sessionId],
  )
  if (!entry) return null
  return h(ClassicPlanReviewCard, { key: entry.callId ?? entry.id, entry, enterToSend, readOnly, actions })
}
