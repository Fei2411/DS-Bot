import { createElement as h, Fragment } from 'react'
import { createPortal } from 'react-dom'
import { PlusIcon } from './icons.js'
import { useAnchoredMenu } from './model-menu.js'
import { call } from './api.js'
import { t } from './i18n.js'

// "New session" in a Bot's chat gives two ways out of a long conversation: a blank
// part, or a part that starts with the handoff package from the one it replaces. Both
// replace the current part, so a working Bot offers neither: it has one conversation
// at a time.
export function newPartChoices({ botId, busy = false, actions, run }) {
  const submit = promise => (typeof run === 'function' ? run(promise) : promise)
  const start = mode => submit(actions?.newPart !== undefined
    ? actions.newPart(botId, mode === 'blank' ? { blank: true } : { handoff: true })
    : call('bot-new-part', { botId, ...(mode === 'blank' ? { blank: true } : { handoff: true }) }))
  return busy ? [] : [
    { mode: 'blank', label: t('Blank session'), start: () => start('blank') },
    { mode: 'handoff', label: t('Continue with handoff'), start: () => start('handoff') },
  ]
}

export function NewPartMenu({ botId, busy = false, actions, run }) {
  const { isOpen, shownPlace, leaving, button, menu, open, close } = useAnchoredMenu()
  const choices = newPartChoices({ botId, busy, actions, run })
  return h(Fragment, null,
    h('button', {
      ref: button, type: 'button', className: 'bt-agent-sessions-new',
      'aria-haspopup': 'menu', 'aria-expanded': isOpen, title: t('New session'), ...(choices.length === 0 ? { disabled: true } : {}),
      onClick: () => (isOpen ? close() : open()),
    }, h(PlusIcon), t('New session')),
    shownPlace ? createPortal(h('div', {
      ref: menu, className: 'bt-menu bt-menu-up', role: 'menu', 'aria-label': t('New session'), style: shownPlace, 'data-leaving': leaving || undefined,
    },
    choices.map(choice => h('button', {
      key: choice.mode, type: 'button', role: 'menuitem',
      onClick: () => { close(); choice.start() },
    }, h('span', { className: 'bt-menu-label' }, choice.label)))), document.body) : null)
}
