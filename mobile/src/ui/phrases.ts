import type { Room } from '../connection.ts'
import { t } from './i18n.ts'

export function roomTitle(room: Pick<Room, 'name' | 'named'>): string {
  if (room.named === true || (room.name !== 'You' && !room.name.startsWith('You, '))) return room.name
  return t('You') + room.name.slice('You'.length)
}

// What a Bot is doing, worded like the desktop's workPhrase (cells.js): what it
// said in its step, else the kind of tool and what it works on.
const TOOL_PHRASES: [RegExp, string][] = [
  [/web_?search|search_?web/i, 'Searching online'],
  [/fetch|browse|browser|web/i, 'Reading a page'],
  [/shell|bash|pwsh|powershell|exec|command|terminal/i, 'Running shell commands'],
  [/^(read|view|cat)\b|read_/i, 'Opening a file'],
  [/write|edit|patch|create_file/i, 'Writing a file'],
  [/recall|memory|remember/i, 'Checking memory'],
]

export function workPhrase(doing: { tool?: string; said?: string; note?: string; target?: string; switching?: boolean; folder?: boolean } | string | undefined): string {
  const { tool, said, note, target, switching, folder } = typeof doing === 'string' ? { tool: doing } : doing ?? {}
  if (switching) return folder === true ? t('Switching working folder') : t('Moving to a fresh conversation')
  const own = (said || note)?.replace(/[\s.。…]+$/u, '')
  if (own) return own
  if (!tool) return t('Thinking about it')
  const matched = TOOL_PHRASES.find(([pattern]) => pattern.test(tool))?.[1]
  const label = matched !== undefined ? t(matched) : t('On it')
  return target ? `${label} · ${target}` : label
}
