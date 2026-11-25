import { createElement as h, useEffect, useRef } from 'react'
import { chatRows, mentionRows, sessionMention } from '../../../ds-bot/src/client/at-menu.js'
import { commandEntries } from '../../../ds-bot/src/client/command-actions.js'
import { canSetGoal } from '../../../ds-bot/src/client/goal.js'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { ChatsIcon, ClockIcon, FolderIcon, GoalIcon, InfoIcon, PeopleIcon, SlidersIcon, TerminalIcon } from '../../../ds-bot/src/client/icons.js'
import { BotMark } from '../../../ds-bot/src/client/mark.js'
import { relativeShort } from '../../../ds-bot/src/client/text.js'
import { ALL_WORDS } from '../../../ds-bot/src/shared/mentions.js'

/**
 * Inspects the composer draft up to `caret` for an active `@` mention or leading `/` command.
 * The query stays bounded by `caret`, while `end` extends through the rest of the token so
 * completing mid-token replaces the whole token cleanly without leaving trailing fragments.
 * @param {string} text
 * @param {number} caret
 * @returns {{ kind: 'mention' | 'command', start: number, end: number, query: string } | null}
 */
export function activeComposerTrigger(text, caret) {
  if (typeof text !== 'string') return null
  const pos = Number.isInteger(caret) ? Math.max(0, Math.min(caret, text.length)) : text.length
  const before = text.slice(0, pos)

  // Leading `/` command: only when the entire prefix before caret is `/<token>` with no spaces.
  if (before.startsWith('/')) {
    const body = before.slice(1)
    if (!/\s/.test(body)) {
      let end = pos
      while (end < text.length && /[A-Za-z0-9_-]/.test(text[end])) end += 1
      return { kind: 'command', start: 0, end, query: body }
    }
  }

  // `@query` preceded by start-of-input or whitespace; no whitespace or second `@` inside query.
  const atIndex = before.lastIndexOf('@')
  if (atIndex >= 0) {
    const prev = atIndex === 0 ? '' : before[atIndex - 1]
    if (atIndex === 0 || /\s/.test(prev)) {
      const query = before.slice(atIndex + 1)
      if (!/[\s@]/.test(query)) {
        let end = pos
        while (end < text.length && /[\p{L}\p{N}_-]/u.test(text[end])) end += 1
        return { kind: 'mention', start: atIndex, end, query }
      }
    }
  }
  return null
}

/**
 * Replaces `[trigger.start, trigger.end]` in `text` with `replacement` and returns the new text and caret.
 * Collapses a duplicate space when `replacement` already ends with a space before an existing space.
 * @param {string} text
 * @param {{ start: number, end: number }} trigger
 * @param {string} replacement
 * @returns {{ text: string, caret: number }}
 */
export function applyTriggerText(text, trigger, replacement) {
  const source = typeof text === 'string' ? text : ''
  const start = Math.max(0, Math.min(trigger?.start ?? source.length, source.length))
  const end = Math.max(start, Math.min(trigger?.end ?? start, source.length))
  const tailStart = replacement.endsWith(' ') && source[end] === ' ' ? end + 1 : end
  const next = source.slice(0, start) + replacement + source.slice(tailStart)
  return { text: next, caret: start + replacement.length }
}

/**
 * Builds the available `/` slash command items for the current Bot or group chat,
 * reusing `commandEntries` from `ds-bot/src/client/command-actions.js`.
 */
export function buildSlashCommands({ roster, sessionId, actions, query = '' }) {
  if (!roster?.ready || !sessionId) return []
  const room = roster.roomsById?.[sessionId]
  const bot = roster.byId?.[sessionId]
  const isAgent = !room && !bot && roster.agentOf?.[sessionId] !== undefined
  if (!room && !bot && !isAgent) return []

  const items = []
  if (isAgent) {
    if (typeof actions?.openFiles === 'function') {
      items.push({
        key: 'cmd:files',
        name: '/files',
        label: t('Files'),
        description: t('Browse workspace files'),
        icon: FolderIcon,
        run: () => actions.openFiles(),
      })
    }
    if (actions?.canOpenTerminal?.() === true && typeof actions?.newTerminal === 'function') {
      items.push({
        key: 'cmd:terminal',
        name: '/terminal',
        label: t('Terminal'),
        description: t('Open a workspace terminal'),
        icon: TerminalIcon,
        run: () => actions.newTerminal(),
      })
    }
    if (typeof actions?.openShortcuts === 'function') {
      items.push({
        key: 'cmd:shortcuts',
        name: '/shortcuts',
        label: t('Keyboard shortcuts'),
        description: t('View keyboard shortcuts'),
        icon: InfoIcon,
        run: () => actions.openShortcuts(),
      })
    }
    const needle = query.trim().toLowerCase()
    if (needle === '') return items
    return items.filter(item => item.name.toLowerCase().includes(needle)
      || item.label.toLowerCase().includes(needle)
      || item.description.toLowerCase().includes(needle))
  }

  const snapshot = { getSnapshot: () => roster }
  const { contributions, decorations } = commandEntries({ roster: snapshot, actions })
  const session = { sessionId }

  for (const contrib of contributions) {
    if (typeof contrib.available === 'function' && !contrib.available(session)) continue
    items.push({
      key: `cmd:${contrib.name}`,
      name: `/${contrib.name}`,
      label: typeof contrib.label === 'function' ? contrib.label() : contrib.name,
      description: typeof contrib.description === 'function' ? contrib.description() : '',
      icon: contrib.icon ?? ClockIcon,
      run: () => contrib.ui?.run?.(session),
    })
  }

  const goalDec = decorations.find(item => item.name === 'goal')
  if (goalDec && canSetGoal(room, roster) && (!goalDec.available || goalDec.available(session))) {
    items.push({
      key: 'cmd:goal',
      name: '/goal',
      label: t('Set a goal'),
      description: t('Set a goal for this group chat'),
      icon: GoalIcon,
      run: () => goalDec.ui?.run?.(session),
    })
  }

  if (typeof actions?.showDetails === 'function') {
    items.push({
      key: 'cmd:details',
      name: '/details',
      label: t('Details'),
      description: t('View conversation details'),
      icon: SlidersIcon,
      run: () => actions.showDetails(sessionId),
    })
  }

  if (typeof actions?.openShortcuts === 'function') {
    items.push({
      key: 'cmd:shortcuts',
      name: '/shortcuts',
      label: t('Keyboard shortcuts'),
      description: t('View keyboard shortcuts'),
      icon: InfoIcon,
      run: () => actions.openShortcuts(),
    })
  }

  const needle = query.trim().toLowerCase()
  if (needle === '') return items
  return items.filter(item => item.name.toLowerCase().includes(needle)
    || item.label.toLowerCase().includes(needle)
    || item.description.toLowerCase().includes(needle))
}

/**
 * Computes the list of selectable items for a composer trigger menu (`mention`, `reference`, or `command`).
 */
export function buildComposerMenuItems({ mode, query = '', roster, sessions, sessionId, actions }) {
  if (!roster?.ready || !sessionId) return []
  if (mode === 'mention') {
    const rows = mentionRows(roster, sessionId, query) ?? []
    return rows.map((row) => {
      // Only emit localized "@Everyone" when `mentionSpans` recognizes the word (e.g. "Everyone", "所有人");
      // otherwise emit "@everyone " so group routing reaches every member across all locales.
      const rawWord = String(row.text ?? '').replace(/^@/, '').trim().toLowerCase()
      const everyoneText = ALL_WORDS.includes(rawWord) ? row.text : '@everyone '
      return {
        key: row.bot ? `bot:${row.bot.id}` : 'room:everyone',
        kind: 'insert',
        bot: row.bot,
        icon: row.bot ? null : PeopleIcon,
        title: row.bot ? row.bot.name : t('Everyone'),
        subtitle: row.bot?.role || (row.room ? t('{count} members', { count: row.room.members.length }) : ''),
        insertText: row.bot ? row.text : everyoneText,
      }
    })
  }
  if (mode === 'reference') {
    const rows = chatRows(roster, sessions, sessionId)
    const needle = query.trim().toLowerCase()
    const filtered = needle === ''
      ? rows
      : rows.filter(row => (row.bot?.name ?? row.label).toLowerCase().includes(needle))
    return filtered.map((row) => ({
      key: `ref:${row.sessionId}`,
      kind: 'insert',
      bot: row.bot,
      icon: row.bot ? null : ChatsIcon,
      title: row.bot ? row.bot.name : row.label,
      subtitle: row.updatedAt ? relativeShort(row.updatedAt) : '',
      insertText: `${sessionMention(row.sessionId, row.label)} `,
    }))
  }
  if (mode === 'command') {
    return buildSlashCommands({ roster, sessionId, actions, query }).map(cmd => ({
      key: cmd.key,
      kind: 'command',
      icon: cmd.icon,
      title: cmd.label,
      code: cmd.name,
      subtitle: cmd.description,
      run: cmd.run,
    }))
  }
  return []
}

const keepFocus = event => event.preventDefault()

/**
 * Floating listbox above the composer for `@` Bot mentions, `+ → Reference a chat`, and `/` commands.
 */
export function ComposerMenu({ items, activeIndex, label, onHover, onSelect }) {
  const listRef = useRef(null)
  useEffect(() => {
    listRef.current?.querySelector?.('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex, items.length])
  if (!Array.isArray(items) || items.length === 0) return null
  const clamped = Math.max(0, Math.min(activeIndex, items.length - 1))
  return h('div', {
    ref: listRef,
    className: 'dsb-cmenu',
    role: 'listbox',
    'aria-label': label,
    onMouseDown: keepFocus,
  }, items.map((item, index) => {
    const selected = index === clamped
    return h('button', {
      key: item.key,
      type: 'button',
      role: 'option',
      className: 'dsb-cmenu-row',
      'aria-selected': selected,
      onMouseMove: () => { if (index !== clamped) onHover?.(index) },
      onClick: () => onSelect?.(item),
    },
    h('span', { className: 'dsb-cmenu-lead', 'aria-hidden': true },
      item.bot ? h(BotMark, { bot: item.bot, size: 18 })
        : item.icon ? h(item.icon) : null),
    h('span', { className: 'dsb-cmenu-text' },
      h('span', { className: 'dsb-cmenu-title' },
        item.title,
        item.code ? h('span', { className: 'dsb-cmenu-code' }, item.code) : null),
      item.subtitle ? h('span', { className: 'dsb-cmenu-sub' }, item.subtitle) : null))
  }))
}
