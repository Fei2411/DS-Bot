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

const ACTIVITY_PHRASES: Record<string, string> = {
  thinking: 'Thinking about it',
  searching: 'Searching online',
  working: 'On it',
  sending: 'On it',
  orbit: 'On it',
}

export type WorkDetail = { tool?: string; said?: string; note?: string; target?: string; switching?: boolean; folder?: boolean; roomId?: string }

// Foreground DM running detail for a Bot: prefers work.bots[id] (structured step) when it
// belongs to the Bot's own chat (roomId === undefined), and falls back to activity[id] only
// when it names an active turn state (never 'waiting' or 'alert').
export function runningActivityOf(workBot: WorkDetail | undefined, activityWord: unknown): WorkDetail | string | undefined {
  if (workBot !== undefined) return workBot.roomId === undefined ? workBot : undefined
  if (typeof activityWord === 'string' && Object.hasOwn(ACTIVITY_PHRASES, activityWord)) return activityWord
  return undefined
}

export function workPhrase(doing: WorkDetail | string | undefined): string {
  if (typeof doing === 'string' && Object.hasOwn(ACTIVITY_PHRASES, doing)) return t(ACTIVITY_PHRASES[doing])
  const { tool, said, note, target, switching, folder } = typeof doing === 'string' ? { tool: doing } : doing ?? {}
  if (switching) return folder === true ? t('Switching working folder') : t('Moving to a fresh conversation')
  const own = (said || note)?.replace(/[\s.。…]+$/u, '')
  if (own) return own
  if (!tool) return t('Thinking about it')
  const matched = TOOL_PHRASES.find(([pattern]) => pattern.test(tool))?.[1]
  const label = matched !== undefined ? t(matched) : t('On it')
  return target ? `${label} · ${target}` : label
}
