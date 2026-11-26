import { mentionSpans } from '../shared/mentions.js'

// DSH 0.2.2-rc.1 draws a user's text by rules: each rule finds the next piece of the
// original text it owns, and a keyed slot draws that piece. Its file rule ends an "@word"
// at the first space, so "@新 Bot" came out as a file "新". This rule claims the whole
// name first, by the same reading the group host calls Bots with.
export const BOT_MENTION_ID = 'bot-mention'

// A lower order wins when two rules find a piece at the same place: DSH's session rule
// is 10, its skill rule 20 and its file and folder rules 30.
const ORDER = 5

// The rule knows every Bot of the team; which of them a chat may call is for the node
// to decide, because a rule sees no Session.
export function botMentionRule(bots) {
  const named = bots.filter(bot => bot?.name)
  return {
    id: BOT_MENTION_ID,
    order: ORDER,
    match(text, from, context) {
      if (named.length === 0) return undefined
      const references = context.read('sessionLabels') ?? []
      const span = mentionSpans(text, named, { references }).find(item => item.bot !== undefined && item.start >= from)
      if (span === undefined) return undefined
      return { id: BOT_MENTION_ID, start: span.start, end: span.end, data: { botId: span.bot.id, label: text.slice(span.start + 1, span.end) } }
    },
  }
}

// Keeps one rule registered for the roster's Bots. A new rule makes DSH read every
// message again, so it is replaced only when a Bot's id or name changed.
export function installBotMentionRule(userText, roster) {
  let key
  let off
  const sync = () => {
    const bots = roster.getSnapshot().bots ?? []
    const next = JSON.stringify(bots.filter(bot => bot?.name).map(bot => [bot.id, bot.name]))
    if (next === key) return
    key = next
    // A rule's id is unique in the registry, so the old one goes first.
    off?.()
    off = userText.register(botMentionRule(bots))
  }
  sync()
  const offRoster = roster.subscribe(sync)
  return () => { offRoster(); off?.() }
}
