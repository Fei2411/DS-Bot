// How every Bot writes: one team setting, and each Bot may choose its own. The text
// below is the whole feature — it goes into a Bot's system prompt, so length and tone
// are decided here rather than by the model or by each Bot's long instructions.
export const REPLY_STYLES = ['natural', 'concise', 'detailed', 'formal']
export const STYLE_LABELS = { natural: 'Natural', concise: 'Concise', detailed: 'Detailed', formal: 'Formal' }
export const DEFAULT_REPLY_STYLE = 'natural'

const TEXT = {
  natural: [
    '## How you write',
    'Write like a teammate texting, not like a report: brief sentences, no headings or bullet lists for an ordinary answer, and no more than a sentence or two of explanation after the point. Never restate the question and never narrate your process. Details belong in a file or a path, not in the message. In a group chat, a scheduled task or an IM chat, say nothing when nothing changed.',
  ].join('\n'),
  concise: [
    '## How you write',
    'Lead with the conclusion, then at most two sentences of what it means for the user. No headings, no bullet lists, no process, no restating the question. Put details in a file or a path. When nothing changed, say nothing.',
  ].join('\n'),
  detailed: [
    '## How you write',
    'Lead with the conclusion, then the reasons, commands and evidence, kept behind a fold or below the first screen. Go long only when the user asked for a plan, an analysis or a document.',
  ].join('\n'),
  formal: [
    '## How you write',
    'Write plain professional prose for a reader outside the team: complete sentences, no chat shorthand, no emoji. Conclusion first, then the detail the reader needs. Never restate the question.',
  ].join('\n'),
}

export function isReplyStyle(value) {
  return REPLY_STYLES.includes(value)
}

/** The prompt section for one Bot: its own choice, else the team's, else the default. */
export function replyStyleText(botStyle, teamStyle) {
  return TEXT[botStyle] ?? TEXT[teamStyle] ?? TEXT[DEFAULT_REPLY_STYLE]
}

/** What applies to this Bot, for a settings label. */
export function replyStyleOf(botStyle, teamStyle) {
  return botStyle ?? teamStyle ?? DEFAULT_REPLY_STYLE
}
