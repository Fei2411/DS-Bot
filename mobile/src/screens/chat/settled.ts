import { t } from '../../ui/i18n.ts'

export interface SettledQuestionData {
  id?: string
  question: string
  detail?: string
  options?: (string | { label: string })[]
}

export interface RelayReplyData {
  kind?: string
  event?: string
  botId?: string
  name?: string
  color?: string
  text?: string
  code?: string
  idle?: boolean
  count?: number
  names?: string[]
}

export const stripLongNote = (text: string) => text.replace(/^\[A long message: \d+ characters\.[^\]\n]*\]\r?\n/, '')

// Host previews come from historyEntry/replyText, which frame card replies as
// "[Browser handoff] …" or "[Answer to question card] …" for compaction context.
export function cleanPreview(raw?: string): string | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const text = stripLongNote(raw).trim()
  const handoff = /^\[Browser handoff\]\s*([^\s—]+)(?:\s*—\s*(.+?))?\s+Answer:\s*\S+$/s.exec(text)
  if (handoff !== null) {
    const title = handoffTitleOf(handoff[1])
    return handoff[2] ? `${title} · ${handoff[2].trim()}` : title
  }
  const qAnswer = /^\[Answer to question card\]\s*(.+?)\s+Answer:\s*(.+)$/s.exec(text)
  if (qAnswer !== null) return qAnswer[2].trim() === '(skipped)' ? qAnswer[1].trim() : qAnswer[2].trim()
  const qCard = /^\[Question card\]\s*(.+?)(?:\s+Options:\s*.+)?$/s.exec(text)
  if (qCard !== null) return qCard[1].trim()
  return text
}

export function settledQuestionPicks(
  question: SettledQuestionData | undefined,
  answer: { selected?: string[]; custom?: string } | undefined,
): { label: string; letter: string }[] {
  const options = (question?.options ?? []).map(opt => (typeof opt === 'string' ? opt : opt.label))
  const selected = Array.isArray(answer?.selected) ? answer.selected : []
  const custom = typeof answer?.custom === 'string' ? answer.custom.trim() : ''
  return [
    ...selected.map((label, j) => {
      const idx = options.indexOf(label)
      return { label, letter: String.fromCharCode(65 + (idx >= 0 ? idx : j)) }
    }),
    ...(custom !== '' ? [{ label: custom, letter: String.fromCharCode(65 + options.length) }] : []),
  ]
}

export function handoffTitleOf(reason?: string): string {
  switch (reason) {
    case 'sign-in': return t('Sign-in needed')
    case 'verification': return t('Verification needed')
    case 'confirmation': return t('Confirmation needed')
    default: return t('Your turn in the browser')
  }
}

export function roundEventText(name: string, event: string | undefined, text?: string, code?: string): string | undefined {
  if (event === undefined) return undefined
  const map: Record<string, () => string> = {
    failed: () => t('{name} could not answer: {reason}', { name, reason: text ?? code ?? '' }),
    lookup: () => (text ? t('{name} looked up its own chat for “{text}”', { name, text }) : t('{name} looked up its own chat', { name })),
    missed: () => t("{name} didn't answer in time", { name }),
    'admin-passed': () => t('{name} did not answer or call anyone; call a member with @Name', { name }),
    resumed: () => t('{name} was cut off by a restart and picked its work back up', { name }),
    cut: () => t('{name} was cut off by a restart again and stopped', { name }),
    approval: () => t('{name} paused for your approval', { name }),
    working: () => t('{name} started on it', { name }),
    folder: () => text ?? '',
    stopped: () => t("You stopped {name}'s work", { name }),
    done: () => t('{name} finished its work', { name }),
    schedule: () => text ?? '',
  }
  return map[event]?.()
}

export function relayReplyText(reply?: RelayReplyData): string | undefined {
  if (reply === undefined) return undefined
  const kind = reply.kind ?? reply.event
  const name = reply.name ?? t('a Bot')
  if (kind === 'paused') {
    const joiner = t(' and ')
    return reply.idle
      ? t('{names} went back and forth {count} times without progress and paused. Write here to go on', { count: reply.count ?? 0, names: [name, ...(reply.names ?? [])].join(joiner) })
      : t('Paused after {count} Bot relays. Waiting: {names}', { count: reply.count ?? 0, names: (reply.names ?? []).join(joiner) })
  }
  return roundEventText(name, kind, reply.text, reply.code)
}
