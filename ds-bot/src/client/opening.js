import { createElement as h } from 'react'
import { BotMark } from './mark.js'
import { PeopleIcon } from './icons.js'
import { t } from './i18n.js'

// -------------------------------------------------------------------------
// The shell's main view opens only a Session its list already holds, so a Session made
// a moment ago leaves the previous chat on screen until it lands (#1196). What is left
// there reads as "the Bot I just opened is showing someone else's conversation", so the
// conversation area shows this quiet state for the Bot that was asked for instead.

// A wait that never ends gives the window back rather than covering it for good.
export const OPENING_WAIT_MS = 5000

// The Bot or group chat to show while its Session lands; null once the main view holds
// it, or when nothing is waiting.
export function openingModel({ pending, current, roster }) {
  if (!pending || pending.target === undefined) return null
  if (current === pending.target) return null
  const bot = roster?.byId?.[pending.id]
  const room = roster?.roomsById?.[pending.id]
  return {
    id: pending.id,
    name: bot?.name ?? room?.name ?? pending.name ?? '',
    bot,
    group: room !== undefined,
  }
}

export function OpeningCover({ model, column }) {
  if (model === null) return null
  return h('div', {
    className: 'bt-opening', style: { left: `${column}px` }, role: 'status', 'aria-live': 'polite',
  },
  h('div', { className: 'bt-opening-card' },
    h('span', { className: 'bt-opening-mark' }, model.bot ? h(BotMark, { bot: model.bot, size: 44 }) : h(PeopleIcon)),
    model.name ? h('span', { className: 'bt-opening-name' }, model.name) : null,
    h('span', { className: 'bt-opening-note' }, t('Opening…'))))
}

export const OPENING_CSS = `
.bt-opening{position:fixed;top:var(--dsh-frame-chrome-top,0px);right:0;bottom:0;z-index:30;display:grid;place-items:center;background:var(--bt-main);color:var(--bt-ink);font-family:var(--bt-font);animation:bt-opening-in .12s ease-out}
.bt-opening-card{display:flex;flex-direction:column;align-items:center;gap:10px;max-width:60vw;min-width:0}
.bt-opening-mark{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;color:var(--bt-ink-3)}
.bt-opening-name{font-size:15px;font-weight:600;line-height:20px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-opening-note{font-size:13px;line-height:18px;color:var(--bt-ink-3)}
@keyframes bt-opening-in{from{opacity:0}to{opacity:1}}
`
