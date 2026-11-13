import { createElement as h, useEffect, useRef } from 'react'
import { t } from './i18n.js'

// Above the composer: the part the user opened is still running in the background, so
// this chat takes no input until that turn ends or the user stops it. Two sessions
// running at once means two model calls.
export function ReadOnlyDock({ sessionId, useUi, useRoster, actions }) {
  const readOnlyPart = useUi(state => state.readOnlyPart)
  const bot = useRoster(state => state.byId?.[sessionId] ?? Object.values(state.byId ?? {}).find(entry => entry?.sessionId === sessionId))
  const running = useRoster(state => state.partsRunning?.[sessionId] === true)
  const active = readOnlyPart !== null && readOnlyPart === sessionId && running
  const root = useRef(null)
  // The part goes idle: what kept the input off is over.
  useEffect(() => {
    if (readOnlyPart !== null && readOnlyPart === sessionId && !running) actions.clearReadOnlyPart?.()
  }, [readOnlyPart, sessionId, running])
  // DSH owns the composer, so a switched-in running session blocks its two send paths
  // here: Enter and the send button.
  useEffect(() => {
    if (!active) return undefined
    const card = root.current?.closest('[data-composer-card]') ?? document.querySelector('[data-composer-card]')
    if (card === null || card === undefined) return undefined
    const onKey = (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && !event.isComposing) {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
    }
    const onClick = (event) => {
      const button = event.target?.closest?.('button')
      if (button === null || button === undefined) return
      if (/send|发送/i.test(button.getAttribute('aria-label') ?? '')) {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
    }
    card.addEventListener('keydown', onKey, true)
    card.addEventListener('click', onClick, true)
    return () => {
      card.removeEventListener('keydown', onKey, true)
      card.removeEventListener('click', onClick, true)
    }
  }, [active])
  return h('div', { ref: root, className: 'bt-readonly-dock', 'data-on': active ? '' : undefined, role: 'status', hidden: !active },
    h('span', { className: 'bt-readonly-text' }, t('This session is still running. Wait for it to finish, or stop it.')),
    h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => actions.stopChat(bot.id) }, t('Stop')))
}

export const READ_ONLY_CSS = `
.bt-readonly-dock{display:none}
.bt-readonly-dock[data-on]{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 6px;padding:8px 10px;border:.5px solid var(--bt-line);border-radius:12px;background:var(--bt-card);font-size:12px;line-height:17px;color:var(--bt-ink-2)}
.bt-readonly-text{min-width:0}
`
