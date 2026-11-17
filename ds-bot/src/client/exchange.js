import { createElement as h, Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { inkText } from './inks.js'
import { dayLabel } from './text.js'
import { colorOf, BotMark } from './mark.js'
import { Bubbles } from './cells.js'
import { stripLongNote } from './fold.js'
import { useEscape } from './overlay-hooks.js'
import { layoutOf } from './themes.js'
import { t } from './i18n.js'

const SHEET_EXIT_MS = 220

export function ExchangeDialog({ pair, paneLeft, roster, actions }) {
  const [entries, setEntries] = useState(null)
  const [leaving, setLeaving] = useState(false)
  const log = useRef(null)
  const atEnd = useRef(true)
  useLayoutEffect(() => {
    if (entries !== null && atEnd.current && log.current) log.current.scrollTop = log.current.scrollHeight
  }, [entries])
  // The sheet slides back down before it unmounts.
  const close = () => {
    if (leaving) return
    setLeaving(true)
    setTimeout(() => actions.closeOverlay(), SHEET_EXIT_MS)
  }
  useEscape(close)
  useEffect(() => {
    let stop = false
    let timer
    let seen = null
    atEnd.current = true
    setEntries(null)
    const load = async () => {
      const result = await actions.exchange(pair[0], pair[1])
      if (stop) return
      const key = JSON.stringify(result ?? [])
      if (key !== seen) { seen = key; setEntries(result ?? []) }
      timer = setTimeout(load, document.hidden ? 8000 : 2000)
    }
    void load()
    return () => { stop = true; clearTimeout(timer) }
  }, [pair[0], pair[1]])
  const left = roster.byId[pair[0]]
  const right = roster.byId[pair[1]]
  const flat = layoutOf(roster.prefs) === 'flat'
  let lastDay = 0
  return h('div', { className: 'bt-pane bt-exchange', style: { left: paneLeft }, 'data-leaving': leaving || undefined },
    h('div', { className: 'bt-dialog', role: 'dialog', 'aria-label': t('Bot exchange') },
      h('div', { className: 'bt-head' }, h('span', { className: 'bt-pill', style: { cursor: 'default' } },
        left ? h(BotMark, { bot: left, size: 22 }) : null, left?.name ?? '?',
        h('span', { className: 'bt-swap' }, '⇄'),
        right ? h(BotMark, { bot: right, size: 22 }) : null, right?.name ?? '?')),
      h('div', { ref: log, className: 'bt-dialog-log', role: 'log', 'aria-label': t('Bot exchange transcript'), onScroll: (event) => {
        const node = event.currentTarget
        atEnd.current = node.scrollHeight - node.scrollTop - node.clientHeight < 2
      } },
        entries === null ? h('div', { className: 'bt-hint' }, t('Loading…'))
          : entries.length === 0 ? h('div', { className: 'bt-hint' }, t('No messages yet'))
            : entries.map((entry) => {
              const bot = roster.byId[entry.from] ?? { id: entry.from, name: t('You'), color: 'gray' }
              const showDay = entry.time - lastDay > 30 * 60 * 1000
              lastDay = entry.time
              // A long message comes with its start only; the rest is read on request.
              const whole = entry.length === undefined ? undefined : { length: entry.length, load: () => actions.exchangeText(entry.id, entry.from, entry.to) }
              const lead = h('span', { className: 'bt-lead' }, h(BotMark, { bot: bot, size: 22 }))
              return h(Fragment, { key: entry.id },
                showDay ? h('time', { className: 'bt-time' }, dayLabel(entry.time)) : null,
                h('div', { className: 'bt-group-msg' },
                  h('span', { className: 'bt-group-name', style: flat ? undefined : { color: inkText(colorOf(bot)) } }, flat ? lead : null, bot.name),
                  h(Bubbles, { texts: [stripLongNote(entry.text)], roster, selfId: bot.id, actions, whole, lead: flat ? null : lead })))
            })),
      h('div', { className: 'bt-dialog-foot' }, h('button', { type: 'button', className: 'bt-soft', onClick: close }, t('Close Chat')))))
}
