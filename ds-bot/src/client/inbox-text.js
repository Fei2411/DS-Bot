// What an inbox item says, shared by the desktop page (inbox.js) and the phone's Needs
// you page (mobile/src/nav/pending.ts). No React here: each side passes its own `t`, so
// both read the same English keys from the one dictionary.

/** The groups, in the order they are worked, with their titles. */
export const INBOX_SECTIONS = [['decide', 'Your call'], ['fix', 'Needs a fix'], ['suggest', 'Suggestions']]

const TAGS = {
  approval: 'Approval', question: 'Question', view: 'Form', secret: 'Secret', connector: 'Connector', mail: 'Email',
  computer: 'Computer', handoff: 'Hand-off', goal: 'Goal', blocked: 'Stopped', model: 'No model', paused: 'Paused',
  'room-paused': 'Paused', learning: 'Proposal',
}

/** The item's tag key, before `t`: what kind of thing waits. */
export const inboxTag = item => TAGS[item?.kind] ?? 'Alert'

/**
 * One line that says what the item is about, in the user's language around the item's
 * own words.
 * @param {object} item an item of the host's inbox list
 * @param {(key: string, params?: Record<string, string | number>) => string} t
 * @param {(botId: string) => string | undefined} [nameOf] a Bot's name, for paused hand-offs
 */
export function inboxSummary(item, t, nameOf = () => undefined) {
  const text = typeof item?.text === 'string' ? item.text : ''
  switch (item?.kind) {
    case 'approval': {
      const what = text ? `${item.tool}: ${text}` : String(item.tool ?? '')
      return item.taskTitle ? `${item.taskTitle} · ${what}` : what
    }
    case 'secret': return t('Asks for the secret {name}', { name: text })
    case 'connector': return t('Asks to connect {name}', { name: text })
    case 'mail': return item.to ? t('Wants to send “{subject}” to {to}', { subject: text, to: item.to }) : t('Wants to send “{subject}”', { subject: text })
    case 'computer': return t('Wants to use {app}', { app: text })
    case 'handoff': return text || (item.surface === 'computer' ? t('Handed you the computer') : t('Handed you its browser'))
    case 'goal': return text ? t('Waiting for you · {title}', { title: text }) : t('Waiting for you')
    case 'blocked': return item.status !== undefined ? t('The model failed ({code} {status})', { code: text, status: item.status }) : t('The model failed ({code})', { code: text })
    case 'model': return t('Choose a model to start')
    case 'paused': {
      const to = item.to === undefined ? undefined : nameOf(item.to)
      return [to ? t('Hand-off to {name} paused', { name: to }) : t('Hand-off paused'), text].filter(Boolean).join(' · ')
    }
    case 'room-paused': return t('Paused after {count} relays', { count: item.count ?? item.limit ?? 0 })
    default: return text
  }
}
