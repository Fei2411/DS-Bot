// The earlier `/btw` aside cards. Their contents are read-only; the user can
// delete a card when it is no longer wanted.
import { createElement as h, useEffect, useMemo, useState } from 'react'
import { MarkdownText } from './dsh-primitives.js'
import { hostText, mdLabels, t } from './i18n.js'
import { CloseIcon } from './icons.js'
import { messageClock } from './text.js'
import { dockCards, tailCards } from './btw-model.js'

const EMPTY_TURN_FACTS = { turns: undefined, openTurn: undefined }
const EMPTY_CARDS = []

export function failureText(card) {
  const raw = typeof card.error === 'string' ? card.error : card.error?.message
  const text = typeof raw === 'string' ? raw.trim() : ''
  return text !== '' ? hostText(text) : t('Could not answer.')
}

function stampOf(card) {
  const time = Number.isFinite(card.finishedAt) ? card.finishedAt : card.createdAt
  return Number.isFinite(time) ? time : undefined
}

export function BtwCardView({ card, compact = false, sessionId, actions, onDeleted }) {
  const [open, setOpen] = useState(card?.status !== 'answering')
  const [deleting, setDeleting] = useState(false)
  useEffect(() => {
    if (card?.status && card.status !== 'answering') setOpen(true)
  }, [card?.status])
  if (!card) return null
  const question = typeof card.question === 'string' ? card.question : ''
  const answer = typeof card.answer === 'string' ? card.answer : ''
  const when = stampOf(card)
  const answering = card.status === 'answering'
  const remove = async () => {
    if (deleting) return
    setDeleting(true)
    try {
      const result = await actions.deleteBtw(card.partId ?? sessionId, card.id)
      if (result?.deleted) onDeleted?.(card.id)
      else setDeleting(false)
    } catch (error) {
      actions.reportError(error, 'btw-delete')
      setDeleting(false)
    }
  }
  return h('div', {
    className: compact ? 'bt-btw bt-btw-compact' : 'bt-btw',
    'data-open': open || undefined,
    'data-status': card.status,
    role: 'region',
    'aria-label': t('Side chat'),
  },
  h('div', { className: 'bt-btw-head' },
    h('button', {
      type: 'button', className: 'bt-btw-toggle', 'aria-expanded': open,
      onClick: () => setOpen(value => !value),
    },
    h('span', { className: 'bt-btw-chevron', 'aria-hidden': true }),
    h('span', { className: 'bt-btw-q' }, question)),
    when !== undefined ? h('time', { className: 'bt-btw-time', dateTime: new Date(when).toISOString() }, messageClock(when)) : null,
    answering ? h('span', { className: 'bt-shimmer' }, t('Answering…')) : null,
    card.status === 'cancelled' ? h('span', { className: 'bt-btw-status' }, t('Cancelled')) : null,
    h('button', {
      type: 'button', className: 'bt-icon-btn bt-btw-delete', disabled: deleting,
      'aria-label': t('Delete side chat'), title: t('Delete side chat'), onClick: () => { void remove() },
    }, h(CloseIcon))),
  h('p', { className: 'bt-btw-note' }, t('Answered from progress so far; nothing was run')),
  open ? h('div', { className: 'bt-btw-body' },
    card.status === 'failed' ? h('p', { className: 'bt-btw-fail' }, failureText(card)) : null,
    answer !== '' ? h('div', { className: 'bt-btw-answer' }, h(MarkdownText, { text: answer, labels: mdLabels(), variant: 'compact' })) : null) : null)
}

export function useTurnFacts(sessionId, actions, active = true) {
  const [facts, setFacts] = useState(() => (active ? actions.turnFacts(sessionId) : EMPTY_TURN_FACTS))
  useEffect(() => {
    if (!active) {
      setFacts(EMPTY_TURN_FACTS)
      return undefined
    }
    let live = true
    const read = () => {
      if (!live) return
      const next = actions.turnFacts(sessionId)
      setFacts(current => (current.turns === next.turns && current.openTurn === next.openTurn ? current : next))
    }
    read()
    const off = actions.watchTurns(sessionId, read)
    return () => { live = false; off() }
  }, [sessionId, actions, active])
  return facts
}

function useSessionBtwCards(useRoster, sessionId) {
  const botCards = useRoster((roster) => {
    if (!roster?.ready || roster.roomsById?.[sessionId]) return null
    const bot = roster.byId?.[sessionId]
    if (!bot) return null
    return roster.btwCards?.[bot.id] ?? null
  })
  return useMemo(() => (Array.isArray(botCards) ? botCards.filter(card => card?.partId === sessionId) : EMPTY_CARDS), [botCards, sessionId])
}

// Cards whose turn is still open, or that no closed turn owns, sit in the
// composer dock. No new cards can arrive, and old ones leave when deleted.
export function BtwDock({ sessionId, useRoster, actions }) {
  const partCards = useSessionBtwCards(useRoster, sessionId)
  const facts = useTurnFacts(sessionId, actions, partCards.length > 0)
  const cards = partCards.length > 0 ? dockCards(partCards, facts) : EMPTY_CARDS
  if (cards.length === 0) return null
  return h('div', { className: 'bt-btw-dock' }, cards.map(card => h(BtwCardView, { key: card.id, card, compact: true, sessionId, actions })))
}

export function BtwTurnTail({ turn, sessionId, useRoster, actions }) {
  const partCards = useSessionBtwCards(useRoster, sessionId)
  const facts = useTurnFacts(sessionId, actions, partCards.length > 0)
  const cards = partCards.length > 0 ? tailCards(partCards, turn, facts?.turns) : EMPTY_CARDS
  if (cards.length === 0) return null
  return h('div', { className: 'bt-btw-stack' }, cards.map(card => h(BtwCardView, { key: card.id, card, sessionId, actions })))
}
