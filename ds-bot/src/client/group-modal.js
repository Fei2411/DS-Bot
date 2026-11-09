import { createElement as h, useEffect, useRef, useState } from 'react'
import { BotAvatar } from './mark.js'
import { CheckIcon, CloseIcon } from './icons.js'
import { useEscape } from './overlay-hooks.js'
import { t } from './i18n.js'

// The centred Add group chat dialog. The first Bot picked leads the group (and
// hands the lead on when unpicked); two Bots at least make one.
export function GroupModal({ roster, actions, leaving }) {
  const [name, setName] = useState('')
  const [picked, setPicked] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef(null)
  const opener = useRef(null)
  // A close before the room comes back must not drag the reader into the new group.
  const cancelled = useRef(false)
  const close = () => {
    cancelled.current = true
    actions.closeGroupChat()
    opener.current?.focus?.()
  }
  useEscape(close)
  useEffect(() => {
    opener.current = document.activeElement ?? null
    inputRef.current?.focus()
  }, [])
  const bots = roster.bots ?? []
  const adminId = picked[0]
  const toggle = (id) => setPicked(list => (list.includes(id) ? list.filter(item => item !== id) : [...list, id]))
  const reason = picked.length === 0 ? t('Choose at least 2 Bots (the admin counts)')
    : picked.length === 1 ? t('Choose at least 1 more member')
      : ''
  const create = async () => {
    if (busy || picked.length < 2) return
    setBusy(true)
    setError('')
    try {
      const room = await actions.createRoom(picked, {
        admin: picked[0],
        greet: true,
        ...(name.trim() ? { name: name.trim() } : {}),
      })
      if (cancelled.current) return
      actions.openSession(room.id)
      close()
    } catch (failure) {
      if (cancelled.current) return
      setError(failure?.message ?? String(failure))
      setBusy(false)
    }
  }
  return h('div', { className: 'bt-gm-layer', 'data-leaving': leaving || undefined },
    h('div', { className: 'bt-scrim bt-gm-scrim', onMouseDown: close }),
    h('div', { className: 'bt-gm', role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'bt-gm-title' },
      h('div', { className: 'bt-gm-head' },
        h('h2', { id: 'bt-gm-title' }, t('Add group chat')),
        h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Close'), onClick: close }, h(CloseIcon))),
      h('div', { className: 'bt-gm-body' },
        h('label', { className: 'bt-gm-field' },
          h('span', { className: 'bt-gm-label' }, t('Group chat name')),
          h('input', {
            ref: inputRef, autoFocus: true, className: 'bt-gm-input', value: name,
            placeholder: t('e.g. Website launch'), 'aria-label': t('Group chat name'),
            onChange: event => setName(event.target.value),
          })),
        h('div', { className: 'bt-gm-pick' },
          h('div', { className: 'bt-gm-pick-head' },
            h('span', { className: 'bt-gm-label' }, t('Select Bots')),
            h('span', { className: 'bt-gm-count' }, t('{count} selected', { count: picked.length }))),
          h('div', { className: 'bt-gm-bots', role: 'group', 'aria-label': t('Select Bots') },
            bots.map(bot => {
              const on = picked.includes(bot.id)
              const leads = bot.id === adminId
              return h('button', {
                key: bot.id, type: 'button', role: 'checkbox', 'aria-checked': on,
                className: 'bt-gm-bot', onClick: () => toggle(bot.id),
              },
                h(BotAvatar, { bot, size: 28, admin: leads, live: false }),
                h('span', { className: 'bt-gm-title' },
                  h('span', { className: 'bt-gm-name' }, bot.name),
                  leads ? h('span', { className: 'bt-gm-admin' }, t('Admin')) : null),
                h('span', { className: 'bt-gm-check', 'aria-hidden': true }, on ? h(CheckIcon) : null))
            }))),
        error ? h('div', { className: 'bt-error bt-gm-error', role: 'alert' }, error) : null),
      h('div', { className: 'bt-gm-foot' },
        h('button', { type: 'button', className: 'bt-gm-create', disabled: busy || picked.length < 2, onClick: () => void create() }, t('Create group chat')),
        reason ? h('span', { className: 'bt-gm-reason' }, reason) : null)))
}
