// Reply feedback for Classic Agent sessions (thumbs up / down, optional category + note,
// submit and retract) routed exclusively through DS Bot's `api/bot` (`engine-feedback-*`).
// Never mounted in Bot chats or groups, which keep their own emoji reaction bar.
import { createElement as h, Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { call } from '../../../ds-bot/src/client/api.js'
import { hostText, t } from '../../../ds-bot/src/client/i18n.js'
import { CloseIcon, ThumbDownIcon, ThumbUpIcon } from '../../../ds-bot/src/client/icons.js'
import { useLinger } from '../../../ds-bot/src/client/motion.js'
import { useEscape } from '../../../ds-bot/src/client/overlay-hooks.js'

const MAX_NOTE_BYTES = 8192

export const FEEDBACK_CATEGORIES = [
  { id: 'task-result', labelKey: 'Task result' },
  { id: 'instruction-following', labelKey: 'Instruction following' },
  { id: 'product-interaction', labelKey: 'Interaction' },
  { id: 'service-stability', labelKey: 'Stability' },
  { id: 'resource-cost', labelKey: 'Cost & speed' },
  { id: 'security-privacy-permission', labelKey: 'Safety & permissions' },
  { id: 'other', labelKey: 'Other' },
]

function utf8Bytes(value) {
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(value).length
  return value.length
}

/**
 * Manages per-session classic reply feedback state, serialized CAS mutations, and
 * version-conflict reconciliation for a single Classic Agent session.
 */
export function useSessionFeedback(sessionId, enabled) {
  const [available, setAvailable] = useState(false)
  const [items, setItems] = useState(() => new Map())
  const [pendingIds, setPendingIds] = useState(() => new Set())
  const itemsRef = useRef(items)
  itemsRef.current = items
  const queuesRef = useRef(new Map())
  const sessionRef = useRef(sessionId)
  sessionRef.current = sessionId

  useEffect(() => {
    setItems(new Map())
    setPendingIds(new Set())
    queuesRef.current.clear()
    if (!enabled || !sessionId) {
      setAvailable(false)
      return undefined
    }
    let alive = true
    void call('engine-feedback-list', { sessionId })
      .then((res) => {
        if (!alive) return
        setAvailable(res?.available === true)
        const map = new Map()
        for (const item of Array.isArray(res?.items) ? res.items : []) {
          if (typeof item?.messageId === 'string' && item.messageId !== '') {
            map.set(item.messageId, item)
          }
        }
        setItems(map)
      })
      .catch(() => {
        if (!alive) return
        setAvailable(false)
      })
    return () => { alive = false }
  }, [sessionId, enabled])

  const enqueue = useCallback((messageId, fn) => {
    const prev = queuesRef.current.get(messageId) ?? Promise.resolve()
    const run = prev.catch(() => {}).then(async () => {
      setPendingIds(set => new Set(set).add(messageId))
      try {
        return await fn()
      } finally {
        if (sessionRef.current === sessionId) {
          setPendingIds((set) => {
            const next = new Set(set)
            next.delete(messageId)
            return next
          })
        }
      }
    })
    queuesRef.current.set(messageId, run)
    return run
  }, [sessionId])

  const submit = useCallback((messageId, { rating, category, note }) => enqueue(messageId, async () => {
    const current = itemsRef.current.get(messageId) ?? null
    const res = await call('engine-feedback-put', {
      sessionId,
      messageId,
      rating,
      ...(category ? { category } : {}),
      ...(typeof note === 'string' && note.trim() !== '' ? { note: note.trim() } : {}),
      ifVersion: current?.version ?? null,
    })
    if (sessionRef.current !== sessionId) return { ok: false, stale: true }
    if (res?.ok && res.item) {
      setItems((prev) => {
        const next = new Map(prev)
        next.set(messageId, res.item)
        return next
      })
      return { ok: true, item: res.item }
    }
    if (res?.error?.code === 'CONFLICT') {
      setItems((prev) => {
        const next = new Map(prev)
        if (res.error.current) next.set(messageId, res.error.current)
        else next.delete(messageId)
        return next
      })
      return { ok: false, conflict: true, message: t('Feedback changed elsewhere. Try again.') }
    }
    return { ok: false, message: hostText(res?.error?.message ?? t('Could not submit feedback')) }
  }), [sessionId, enqueue])

  const retract = useCallback((messageId) => enqueue(messageId, async () => {
    const current = itemsRef.current.get(messageId) ?? null
    if (!current?.version) return { ok: true, absent: true }
    const res = await call('engine-feedback-delete', {
      sessionId,
      messageId,
      ifVersion: current.version,
    })
    if (sessionRef.current !== sessionId) return { ok: false, stale: true }
    if (res?.ok) {
      setItems((prev) => {
        const next = new Map(prev)
        next.delete(messageId)
        return next
      })
      return { ok: true, absent: true }
    }
    if (res?.error?.code === 'CONFLICT') {
      setItems((prev) => {
        const next = new Map(prev)
        if (res.error.current) next.set(messageId, res.error.current)
        else next.delete(messageId)
        return next
      })
      return { ok: !res.error.current, conflict: Boolean(res.error.current), message: t('Feedback changed elsewhere. Try again.') }
    }
    return { ok: false, message: hostText(res?.error?.message ?? t('Could not remove feedback')) }
  }), [sessionId, enqueue])

  return useMemo(
    () => ({ available, items, pendingIds, submit, retract }),
    [available, items, pendingIds, submit, retract],
  )
}

/**
 * Thumbs-up / thumbs-down action buttons shown on completed Classic Agent replies.
 */
export function ClassicFeedbackActions({ messageId, item, pending = false, readOnly = false, onSelect, onRetract }) {
  if (!messageId || readOnly) return null
  const isPositive = item?.rating === 'positive'
  const isNegative = item?.rating === 'negative'
  const upLabel = isPositive ? t('Remove positive feedback') : t('Good response')
  const downLabel = isNegative ? t('Remove negative feedback') : t('Poor response')

  return h(Fragment, null,
    h('button', {
      type: 'button',
      className: `dsb-dsh-act-btn dsb-fb-btn${isPositive ? ' is-active is-positive' : ''}`,
      'aria-label': upLabel,
      'aria-pressed': isPositive,
      title: upLabel,
      disabled: pending,
      'data-feedback-rating': 'positive',
      onClick: () => {
        if (isPositive) onRetract?.(messageId)
        else onSelect?.(messageId, 'positive')
      },
    }, h(ThumbUpIcon)),
    h('button', {
      type: 'button',
      className: `dsb-dsh-act-btn dsb-fb-btn${isNegative ? ' is-active is-negative' : ''}`,
      'aria-label': downLabel,
      'aria-pressed': isNegative,
      title: downLabel,
      disabled: pending,
      'data-feedback-rating': 'negative',
      onClick: () => {
        if (isNegative) onRetract?.(messageId)
        else onSelect?.(messageId, 'negative')
      },
    }, h(ThumbDownIcon)))
}

/**
 * Modal dialog collecting optional category and note when rating a Classic Agent reply.
 */
export function ClassicFeedbackDialog({ draft, current, pending = false, error = '', onClose, onSubmit }) {
  const [shown, leaving] = useLinger(draft, 160)
  const [category, setCategory] = useState('')
  const [note, setNote] = useState('')
  const noteRef = useRef(null)

  useEffect(() => {
    if (!draft) return
    setCategory(current?.rating === draft.rating && typeof current?.category === 'string' ? current.category : '')
    setNote(current?.rating === draft.rating && typeof current?.note === 'string' ? current.note : '')
  }, [draft?.messageId, draft?.rating, current])

  useEffect(() => {
    if (!draft) return undefined
    const id = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(() => noteRef.current?.focus())
      : 0
    return () => { if (id && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id) }
  }, [draft])

  useEscape(Boolean(draft) && !pending, onClose)

  if (!shown) return null

  const bytes = utf8Bytes(note)
  const tooLong = bytes > MAX_NOTE_BYTES
  const title = shown.rating === 'positive' ? t('Good response') : t('Poor response')

  const handleSubmit = (event) => {
    event?.preventDefault?.()
    if (pending || tooLong) return
    onSubmit?.({
      messageId: shown.messageId,
      rating: shown.rating,
      category: category || undefined,
      note,
    })
  }

  const modal = h('div', {
    className: 'dsb-fb-backdrop',
    'data-leaving': leaving || undefined,
    onClick: (event) => { if (event.target === event.currentTarget && !pending) onClose?.() },
  },
  h('form', {
    className: 'dsb-fb-dialog',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': title,
    onSubmit: handleSubmit,
  },
  h('div', { className: 'dsb-fb-head' },
    h('h2', { className: 'dsb-fb-title' }, title),
    h('button', {
      type: 'button',
      className: 'bt-icon-btn',
      'aria-label': t('Close'),
      title: t('Close'),
      disabled: pending,
      onClick: onClose,
    }, h(CloseIcon))),
  h('div', { className: 'dsb-fb-cats', role: 'group', 'aria-label': t('Category') },
    FEEDBACK_CATEGORIES.map((cat) => {
      const active = category === cat.id
      return h('button', {
        key: cat.id,
        type: 'button',
        className: `dsb-fb-cat${active ? ' is-selected' : ''}`,
        'aria-pressed': active,
        disabled: pending,
        onClick: () => setCategory(value => (value === cat.id ? '' : cat.id)),
      }, t(cat.labelKey))
    })),
  h('textarea', {
    ref: noteRef,
    className: 'dsb-fb-note',
    rows: 4,
    value: note,
    disabled: pending,
    placeholder: t('Add an optional note…'),
    'aria-label': t('Feedback note'),
    onChange: event => setNote(event.target.value),
    onKeyDown: (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        handleSubmit()
      }
    },
  }),
  tooLong ? h('div', { className: 'dsb-fb-err', role: 'alert' }, t('Note is too long')) : null,
  error ? h('div', { className: 'dsb-fb-err', role: 'alert' }, error) : null,
  h('div', { className: 'dsb-fb-foot' },
    h('button', {
      type: 'button',
      className: 'bt-soft',
      disabled: pending,
      onClick: onClose,
    }, t('Cancel')),
    h('button', {
      type: 'submit',
      className: 'dsb-fb-submit',
      disabled: pending || tooLong,
    }, pending ? t('Submitting…') : t('Submit')))))

  const target = typeof document !== 'undefined' && document?.body ? document.body : null
  return target ? createPortal(modal, target) : modal
}
