import { createElement as h } from 'react'
import { BotMark } from './mark.js'
import { PeopleIcon } from './icons.js'
import { t } from './i18n.js'

// -------------------------------------------------------------------------
// The shell's main view opens only a Session its list already holds, so a Session made
// a moment ago leaves the previous chat on screen until it lands (#1196). What is left
// there reads as "the Bot I just opened is showing someone else's conversation", so the
// conversation area shows this quiet state for the Bot that was asked for instead.
// The cover stays until that Session is the one on screen, or the user opens something
// else. A long wait only changes the note; it never uncovers the chat that was there.

// How long "Opening…" stays before the note says the Session is still on its way.
// This timer does not take the cover down.
export const OPENING_WAIT_MS = 5000

// The same wait, once its note should change. A different target, or no wait, is left
// as it is — a late timer must not clear a cover the user has already moved on from.
function openingPastWait(pending, target) {
  if (!pending || pending.target !== target || pending.slow === true) return pending ?? null
  return { ...pending, slow: true }
}

// One cover for one asked-for Session. `end` is the only way down (that Session is
// current, or the user opened something else). When the wait runs long, `onSlow` runs
// once and the cover stays up.
export function bindOpeningWait(ui, { waitMs = OPENING_WAIT_MS, schedule = setTimeout, clear = clearTimeout, onSlow } = {}) {
  let timer = null
  const stop = () => {
    if (timer === null) return
    clear(timer)
    timer = null
  }
  return {
    begin(pending) {
      ui.set(state => ({ ...state, pendingOpen: pending }))
      stop()
      const target = pending?.target
      timer = schedule(() => {
        timer = null
        let held = false
        ui.set(state => {
          const pendingOpen = openingPastWait(state.pendingOpen, target)
          held = pendingOpen !== state.pendingOpen
          return held ? { ...state, pendingOpen } : state
        })
        if (held) onSlow?.()
      }, waitMs)
    },
    end() {
      stop()
      ui.set(state => (state.pendingOpen === null ? state : { ...state, pendingOpen: null }))
    },
  }
}

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
    slow: pending.slow === true,
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
    h('span', { className: 'bt-opening-note' }, t(model.slow ? 'Still opening…' : 'Opening…'))))
}

export const OPENING_CSS = `
.bt-opening{position:fixed;top:var(--dsh-frame-chrome-top,0px);right:0;bottom:0;z-index:30;display:grid;place-items:center;background:var(--bt-main);color:var(--bt-ink);font-family:var(--bt-font);animation:bt-opening-in .12s ease-out}
.bt-opening-card{display:flex;flex-direction:column;align-items:center;gap:10px;max-width:60vw;min-width:0}
.bt-opening-mark{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;color:var(--bt-ink-3)}
.bt-opening-name{font-size:15px;font-weight:600;line-height:20px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-opening-note{font-size:13px;line-height:18px;color:var(--bt-ink-3)}
@keyframes bt-opening-in{from{opacity:0}to{opacity:1}}
`
