import { createElement as h, Fragment, useEffect, useRef } from 'react'
import { chatRows, mentionRows, sessionMention } from '../../../ds-bot/src/client/at-menu.js'
import { commandEntries } from '../../../ds-bot/src/client/command-actions.js'
import { canSetGoal } from '../../../ds-bot/src/client/goal.js'
import { t } from '../../../ds-bot/src/client/i18n.js'
import {
  BlocksIcon, ChatsIcon, ClockIcon, DownloadIcon, FileIcon, FolderIcon, GoalIcon,
  InfoIcon, LayersIcon, PeopleIcon, SendIcon, ShieldIcon, SlidersIcon, TerminalIcon,
} from '../../../ds-bot/src/client/icons.js'
import { BotMark } from '../../../ds-bot/src/client/mark.js'
import { relativeShort } from '../../../ds-bot/src/client/text.js'
import { ALL_WORDS } from '../../../ds-bot/src/shared/mentions.js'
import { PlanModeIcon } from './classic-controls.js'

const CLASSIC_COMMAND_FACES = {
  compact: { label: 'Compact conversation', description: 'Summarize earlier messages to free context', icon: LayersIcon },
  permission: { label: 'Switch permission preset', description: 'Change permission level for this session', icon: ShieldIcon },
  goal: { label: 'Set a goal', description: '', icon: GoalIcon },
  export: { label: 'Export conversation', description: '', icon: DownloadIcon },
  feedback: { label: 'Send feedback', description: '', icon: SendIcon },
}

function cleanSubtitle(raw, ...duplicates) {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (value === '') return ''
  const lower = value.toLowerCase()
  for (const other of duplicates) {
    if (typeof other === 'string' && other.trim().toLowerCase() === lower) return ''
  }
  return value
}

const SLASH_FILES_LIMIT_EMPTY = 10
const SLASH_FILES_LIMIT_QUERY = 24

/**
 * Formats a workspace file or directory candidate as DSH `@file` / `@"path with spaces"` prompt text.
 * Directories keep a trailing `/` (and open quote when quoted) so completion can keep descending.
 */
export function formatClassicFileMention(candidate, preserveQuote = false) {
  if (!candidate || typeof candidate.path !== 'string' || candidate.path === '') return ''
  const path = candidate.kind === 'directory' ? `${candidate.path.replace(/\/+$/, '')}/` : candidate.path
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f-\x9f"]/.test(path)) return ''
  const quoted = preserveQuote || /\s/.test(path)
  if (!quoted) return `@${path}`
  if (candidate.kind === 'directory') return `@"${path}`
  return `@"${path}"`
}

/**
 * Inspects the composer draft up to `caret` for an active `@` mention or leading `/` command.
 * The query stays bounded by `caret`, while `end` extends through the rest of the token so
 * completing mid-token replaces the whole token cleanly without leaving trailing fragments.
 * When `fileMentions` is true (Classic Agent sessions), `@` also supports paths with slashes/dots
 * and `@"quoted paths`.
 * @param {string} text
 * @param {number} caret
 * @param {{ fileMentions?: boolean }} [options]
 * @returns {{ kind: 'mention' | 'command', start: number, end: number, query: string, quoted?: boolean } | null}
 */
export function activeComposerTrigger(text, caret, { fileMentions = false } = {}) {
  if (typeof text !== 'string') return null
  const pos = Number.isInteger(caret) ? Math.max(0, Math.min(caret, text.length)) : text.length
  const before = text.slice(0, pos)

  // Leading `/` command: only when the entire prefix before caret is `/<token>` with no spaces.
  if (before.startsWith('/')) {
    const body = before.slice(1)
    if (!/\s/.test(body)) {
      let end = pos
      const tokenChar = fileMentions ? /[^\s]/ : /[A-Za-z0-9_-]/
      while (end < text.length && tokenChar.test(text[end])) end += 1
      return { kind: 'command', start: 0, end, query: body }
    }
  }

  if (fileMentions) {
    const quotedMatch = /(?:^|\s)(@"([^"]*))$/u.exec(before)
    if (quotedMatch?.[1] !== undefined && quotedMatch[2] !== undefined) {
      const start = pos - quotedMatch[1].length
      let end = pos
      const closeQuote = text.indexOf('"', pos)
      // Extend through the matching closing quote on the same line only when the remainder of the
      // line has an odd number of quotes (meaning this `@"` actually has a closing quote rather
      // than being unclosed before later balanced prose like `and explain "hello"`).
      if (closeQuote >= pos) {
        const between = text.slice(pos, closeQuote)
        const rest = text.slice(pos)
        const nlIdx = rest.search(/[\r\n]/)
        const restOfLine = nlIdx >= 0 ? rest.slice(0, nlIdx) : rest
        const remainingQuotes = (restOfLine.match(/"/g) ?? []).length
        if (remainingQuotes % 2 === 1 && !/[\r\n]/.test(between) && !text.slice(pos, closeQuote + 1).includes('@"')) {
          end = closeQuote + 1
        }
      }
      return { kind: 'mention', start, end, query: quotedMatch[2], quoted: true }
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
        const tailChar = fileMentions ? /[\p{L}\p{N}_./-]/u : /[\p{L}\p{N}_-]/u
        while (end < text.length && tailChar.test(text[end])) end += 1
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

function fileTitleAndDir(rawPath) {
  const clean = String(rawPath ?? '').replace(/\/+$/, '')
  const slash = clean.lastIndexOf('/')
  if (slash < 0) return { title: clean, dir: '' }
  return { title: clean.slice(slash + 1), dir: clean.slice(0, slash) }
}

function matchesQuery(needle, ...fields) {
  if (needle === '') return true
  return fields.some(field => typeof field === 'string' && field.toLowerCase().includes(needle))
}

/**
 * Builds the available `/` slash command items for the current Bot, group, or Classic Agent chat.
 * For Classic Agent chats, merges DSH host commands, user-invocable skills, and workspace files
 * when `classicCatalog` is provided alongside the built-in `/files`, `/terminal`, and `/shortcuts`.
 */
export function buildSlashCommands({ roster, sessionId, actions, query = '', classicCatalog = null, onRunCommand = null }) {
  if (!roster?.ready || !sessionId) return []
  const room = roster.roomsById?.[sessionId]
  const bot = roster.byId?.[sessionId]
  const isAgent = !room && !bot && roster.agentOf?.[sessionId] !== undefined
  if (!room && !bot && !isAgent) return []

  const needle = query.trim().toLowerCase()

  if (isAgent) {
    const items = []
    const seenCmds = new Set()
    const hostCommands = Array.isArray(classicCatalog?.commands) ? classicCatalog.commands : []
    const skills = Array.isArray(classicCatalog?.skills) ? classicCatalog.skills : []
    const files = Array.isArray(classicCatalog?.files) ? classicCatalog.files : []
    const hasRichCatalog = hostCommands.length > 0 || skills.length > 0 || files.length > 0

    const planActive = classicCatalog?.planActive === true
    for (const cmd of hostCommands) {
      if (!cmd?.name || seenCmds.has(cmd.name)) continue
      seenCmds.add(cmd.name)
      if (cmd.name === 'plan') {
        const code = planActive ? '/plan off' : '/plan'
        const label = planActive ? t('Exit plan mode') : t('Enter plan mode')
        const description = cleanSubtitle(
          planActive ? t('Leave plan mode') : t('Plan before making changes'),
          label,
          code,
        )
        if (!matchesQuery(needle, '/plan', code, 'plan', label, description)) continue
        items.push({
          key: 'host-cmd:plan',
          kind: 'command',
          name: code,
          label,
          description,
          icon: PlanModeIcon,
          ...(hasRichCatalog ? { section: t('Commands') } : {}),
          run: () => onRunCommand?.(code),
        })
        continue
      }
      const face = CLASSIC_COMMAND_FACES[cmd.name]
      const code = `/${cmd.name}`
      const label = face ? t(face.label) : code
      const rawDescription = face ? (face.description ? t(face.description) : '') : (cmd.description || '')
      const description = cleanSubtitle(rawDescription, label, code)
      const icon = face?.icon ?? TerminalIcon
      // Commands with an input hint insert `/<name> ` so the user can supply arguments.
      const insertOnly = cmd.input !== undefined
      if (!matchesQuery(needle, code, cmd.name, label, description)) continue
      items.push({
        key: `host-cmd:${cmd.name}`,
        kind: insertOnly ? 'insert' : 'command',
        name: code,
        label,
        description,
        icon,
        ...(hasRichCatalog ? { section: t('Commands') } : {}),
        ...(insertOnly
          ? { insertText: `${code} ` }
          : { run: () => onRunCommand?.(code) }),
      })
    }

    if (typeof actions?.openFiles === 'function' && !seenCmds.has('files')) {
      const label = t('Files')
      const description = t('Browse workspace files')
      if (matchesQuery(needle, '/files', label, description)) {
        items.push({
          key: 'cmd:files',
          kind: 'command',
          name: '/files',
          label,
          description,
          icon: FolderIcon,
          ...(hasRichCatalog ? { section: t('Commands') } : {}),
          run: () => actions.openFiles(),
        })
      }
    }
    if (actions?.canOpenTerminal?.() === true && typeof actions?.newTerminal === 'function' && !seenCmds.has('terminal')) {
      const label = t('Terminal')
      const description = t('Open a workspace terminal')
      if (matchesQuery(needle, '/terminal', label, description)) {
        items.push({
          key: 'cmd:terminal',
          kind: 'command',
          name: '/terminal',
          label,
          description,
          icon: TerminalIcon,
          ...(hasRichCatalog ? { section: t('Commands') } : {}),
          run: () => actions.newTerminal(),
        })
      }
    }
    if (typeof actions?.openShortcuts === 'function' && !seenCmds.has('shortcuts')) {
      const label = t('Keyboard shortcuts')
      const description = t('View keyboard shortcuts')
      if (matchesQuery(needle, '/shortcuts', label, description)) {
        items.push({
          key: 'cmd:shortcuts',
          kind: 'command',
          name: '/shortcuts',
          label,
          description,
          icon: InfoIcon,
          ...(hasRichCatalog ? { section: t('Commands') } : {}),
          run: () => actions.openShortcuts(),
        })
      }
    }

    for (const skill of skills) {
      if (!skill?.name) continue
      const code = `/${skill.name}`
      const desc = cleanSubtitle(skill.description || skill.whenToUse || '', skill.name, code)
      if (!matchesQuery(needle, code, skill.name, desc)) continue
      items.push({
        key: `skill:${skill.name}`,
        kind: 'insert',
        name: code,
        label: skill.name,
        description: desc,
        icon: BlocksIcon,
        section: t('Skills'),
        insertText: `${code} `,
      })
    }

    const fileLimit = needle === '' ? SLASH_FILES_LIMIT_EMPTY : SLASH_FILES_LIMIT_QUERY
    let fileCount = 0
    for (const entry of files) {
      if (fileCount >= fileLimit) break
      if (!entry?.path) continue
      if (!matchesQuery(needle, entry.path)) continue
      const formatted = formatClassicFileMention(entry, false)
      if (!formatted) continue
      const { title, dir } = fileTitleAndDir(entry.path)
      const label = entry.kind === 'directory' ? `${title}/` : title
      items.push({
        key: `file:${entry.kind}:${entry.path}`,
        kind: 'insert',
        name: entry.kind === 'directory' ? `${entry.path}/` : entry.path,
        label,
        description: cleanSubtitle(dir, label, title),
        icon: entry.kind === 'directory' ? FolderIcon : FileIcon,
        section: t('Files'),
        insertText: entry.kind === 'directory' ? formatted : `${formatted} `,
      })
      fileCount += 1
    }

    return items
  }

  const items = []
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

  if (needle === '') return items
  return items.filter(item => item.name.toLowerCase().includes(needle)
    || item.label.toLowerCase().includes(needle)
    || item.description.toLowerCase().includes(needle))
}

/**
 * Computes the list of selectable items for a composer trigger menu (`mention`, `reference`, or `command`).
 */
export function buildComposerMenuItems({ mode, query = '', quoted = false, roster, sessions, sessionId, actions, classicCatalog = null, onRunCommand = null }) {
  if (!roster?.ready || !sessionId) return []
  const isAgent = !roster.byId?.[sessionId] && !roster.roomsById?.[sessionId] && roster.agentOf?.[sessionId] !== undefined

  if (mode === 'mention') {
    if (isAgent) {
      const files = Array.isArray(classicCatalog?.files) ? classicCatalog.files : []
      const out = []
      for (const entry of files.slice(0, 32)) {
        if (!entry?.path) continue
        const formatted = formatClassicFileMention(entry, quoted)
        if (!formatted) continue
        const { title, dir } = fileTitleAndDir(entry.path)
        const label = entry.kind === 'directory' ? `${title}/` : title
        out.push({
          key: `atfile:${entry.kind}:${entry.path}`,
          kind: 'insert',
          icon: entry.kind === 'directory' ? FolderIcon : FileIcon,
          title: label,
          subtitle: cleanSubtitle(dir, label, title),
          section: t('Workspace files'),
          insertText: entry.kind === 'directory' ? formatted : `${formatted} `,
        })
      }
      return out
    }
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
    return buildSlashCommands({ roster, sessionId, actions, query, classicCatalog, onRunCommand }).map(cmd => ({
      key: cmd.key,
      kind: cmd.kind === 'insert' ? 'insert' : 'command',
      icon: cmd.icon,
      title: cmd.label,
      code: cmd.section === t('Files') ? undefined : cmd.name,
      subtitle: cmd.description,
      ...(cmd.section ? { section: cmd.section } : {}),
      ...(cmd.insertText !== undefined ? { insertText: cmd.insertText } : {}),
      ...(cmd.run ? { run: cmd.run } : {}),
    }))
  }
  return []
}

const keepFocus = event => event.preventDefault()

/**
 * Floating listbox above the composer for `@` mentions/files, `+ → Reference a chat`, and `/` commands/skills/files.
 */
export function ComposerMenu({ items, activeIndex, label, onHover, onSelect }) {
  const listRef = useRef(null)
  useEffect(() => {
    listRef.current?.querySelector?.('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex, items.length])
  if (!Array.isArray(items) || items.length === 0) return null
  const clamped = Math.max(0, Math.min(activeIndex, items.length - 1))
  let lastSection
  return h('div', {
    ref: listRef,
    className: 'dsb-cmenu',
    role: 'listbox',
    'aria-label': label,
    onMouseDown: keepFocus,
  }, items.map((item, index) => {
    const selected = index === clamped
    const showHeading = item.section && item.section !== lastSection
    if (item.section) lastSection = item.section
    return h(Fragment, { key: item.key },
      showHeading ? h('div', { className: 'dsb-cmenu-sec', role: 'presentation' }, item.section) : null,
      h('button', {
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
        item.subtitle ? h('span', { className: 'dsb-cmenu-sub' }, item.subtitle) : null)))
  }))
}
