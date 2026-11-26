import { createElement as h, useId, useRef, useState } from 'react'
import { t } from './i18n.js'

// -------------------------------------------------------------------------
// Paused Bot-to-Bot work card: shown above the composer (and inside the Bot
// exchange dialog) when a delegation or ask_back hit a loop checkpoint.
// Nothing is dropped: Continue runs the held call verbatim; Cancel closes it.

const EMPTY = []

function titleFor(work, fromName, toName) {
  if (work.kind === 'ask_back') {
    return t('Paused question from {from} to {to}', { from: toName, to: fromName })
  }
  return t('Paused delegation from {from} to {to}', { from: fromName, to: toName })
}

function reasonFor(work) {
  switch (work.reason) {
    case 'idle_loop':
      return t('Went back and forth without running work tools')
    case 'ask_back_limit':
      return t('Asked back {count} times without resolving', { count: work.rounds ?? 2 })
    case 'rework_limit':
      return t('Repeated {count} consecutive hand-offs since your last message', { count: work.bounces ?? 4 })
    default:
      return t('Paused for your decision')
  }
}

export function WorkPauseCard({ work, roster, actions, inline = false, showViewChat = false }) {
  const [closed, setClosed] = useState(false)
  const busyRef = useRef(false)
  const titleId = useId()
  const fromName = roster.byId[work.from]?.name ?? work.fromName ?? t('a Bot')
  const toName = roster.byId[work.to]?.name ?? work.toName ?? t('a Bot')
  const refTag = work.ref ? `#${work.ref}` : ''
  const detail = work.kind === 'ask_back' ? (work.question || work.goal) : work.goal

  const run = (fn) => {
    if (busyRef.current) return
    busyRef.current = true
    setClosed(true)
    void Promise.resolve().then(fn).catch((error) => {
      setClosed(false)
      actions.reportError?.(error, 'work-pause')
    }).finally(() => { busyRef.current = false })
  }

  return h('div', {
    className: inline ? 'bt-q-inline' : 'bt-q-dock',
    style: closed ? { display: 'none' } : undefined,
  },
  h('section', { className: inline ? 'bt-q bt-work-pause' : 'bt-q bt-q-raised bt-work-pause', role: 'group', 'aria-labelledby': titleId },
    h('div', { className: 'bt-q-head' },
      h('div', { className: 'bt-q-text' },
        h('p', { className: 'bt-q-title', id: titleId },
          refTag ? h('span', { className: 'bt-tag', style: { marginRight: '6px' } }, refTag) : null,
          titleFor(work, fromName, toName)),
        h('div', { className: 'bt-q-detail' }, reasonFor(work)),
        detail ? h('div', { className: 'bt-work-pause-goal' }, detail) : null)),
    h('div', { className: 'bt-q-foot' },
      h('button', { type: 'button', className: 'bt-q-btn', onClick: () => run(() => actions.cancelWork?.(work.id)) }, t('Cancel')),
      showViewChat && work.from && work.to
        ? h('button', { type: 'button', className: 'bt-q-btn', onClick: () => actions.openExchange?.(work.from, work.to) }, t('View chat'))
        : null,
      h('button', { type: 'button', className: 'bt-q-submit', onClick: () => run(() => actions.resumeWork?.(work.id)) }, t('Continue')))))
}

// Mounted in conversation.input.dock: surfaces paused Bot-to-Bot works involving the open Bot.
export function WorkPauseDock({ sessionId, useRoster, useWork, actions }) {
  const roster = useRoster(value => value)
  const paused = useWork(state => state.paused ?? EMPTY)
  const bot = roster.byId[sessionId]
  if (!bot || paused.length === 0) return null
  const own = paused.filter(item => item.from === bot.id || item.to === bot.id)
  if (own.length === 0) return null
  return h('div', null, own.map(item => h(WorkPauseCard, {
    key: item.id,
    work: item,
    roster,
    actions,
    inline: false,
    showViewChat: true,
  })))
}
