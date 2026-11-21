// -------------------------------------------------------------------------
// Text helpers
import { dateLocale, t } from './i18n.js'
import { mentionSpans } from '../shared/mentions.js'

export const MENTION_ORIGIN = 'https://bots.local/'

// The Bots a text calls, by the rule the group host reads (shared/mentions.js). The
// speaker's own name takes part so that it is never read as a shorter name inside it
// ("@新 Bot" in "@新 Bot 2"); it then stays plain text.
export function linkMentions(text, bots, selfId) {
  if (!text || !text.includes('@')) return text
  let out = ''
  let cursor = 0
  for (const span of mentionSpans(text, bots)) {
    if (!span.bot || span.bot.id === selfId) continue
    out += `${text.slice(cursor, span.start)}[${text.slice(span.start + 1, span.end).replace(/[[\]\\]/g, '\\$&')}](${MENTION_ORIGIN}${span.bot.id})`
    cursor = span.end
  }
  return cursor === 0 ? text : out + text.slice(cursor)
}

const DRIVE_BACKSLASH_PATH = /^[A-Za-z]:\\/
const isEscaped = (text, index) => {
  let slashes = 0
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i -= 1) slashes += 1
  return (slashes & 1) === 1
}
const lineEnd = (text, from) => {
  const nl = text.indexOf('\n', from)
  return nl === -1 ? text.length : nl + 1
}
const isBlankLine = (text, start, end) => /^[ \t]*\r?\n?$/.test(text.slice(start, end))

function fenceOpen(line) {
  const match = /^[ ]{0,3}(`{3,}|~{3,})([^\r\n]*)\r?\n?$/.exec(line)
  if (!match) return null
  const marker = match[1]
  // CommonMark: backtick fence info strings may not contain backticks.
  if (marker[0] === '`' && match[2].includes('`')) return null
  return { char: marker[0], length: marker.length }
}

function fenceClose(line, fence) {
  const match = /^[ ]{0,3}(`{3,}|~{3,})[ \t]*\r?\n?$/.exec(line)
  return Boolean(match && match[1][0] === fence.char && match[1].length >= fence.length)
}

// Find the closing run of exactly `ticks` backticks for a CommonMark code span.
// Code spans may cross single newlines, not blank lines; unmatched ticks are literal.
function findCodeSpanEnd(text, from, ticks) {
  let i = from
  while (i < text.length) {
    if (text[i] === '\n') {
      const next = i + 1
      const nextEnd = lineEnd(text, next)
      if (next < text.length && isBlankLine(text, next, nextEnd)) return -1
      i = next
      continue
    }
    if (text[i] === '`') {
      let end = i
      while (end < text.length && text[end] === '`') end += 1
      if (end - i === ticks) return end
      i = end
      continue
    }
    i += 1
  }
  return -1
}

// Skip optional CommonMark inline-link whitespace (spaces/tabs and up to one newline).
function skipLinkWs(text, from) {
  let i = from
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i += 1
  if (text[i] === '\r' && text[i + 1] === '\n') i += 2
  else if (text[i] === '\n') i += 1
  else return i
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i += 1
  return i
}

// Scan an optional CommonMark link title ("...", '...', (...)) followed by closing ')'.
function skipOptionalTitleAndClose(text, from) {
  let i = skipLinkWs(text, from)
  if (i >= text.length) return -1
  if (text[i] === ')') return i + 1
  const open = text[i]
  if (open !== '"' && open !== "'" && open !== '(') return -1
  // A title must be separated from the destination by at least one whitespace character.
  if (i === from) return -1
  const close = open === '(' ? ')' : open
  i += 1
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\\' && i + 1 < text.length) { i += 2; continue }
    if (ch === '\n') {
      const nextEnd = lineEnd(text, i + 1)
      if (i + 1 < text.length && isBlankLine(text, i + 1, nextEnd)) return -1
      i += 1
      continue
    }
    if (open === '(' && ch === '(') return -1
    if (ch === close) {
      const after = skipLinkWs(text, i + 1)
      return text[after] === ')' ? after + 1 : -1
    }
    i += 1
  }
  return -1
}

// CommonMark eats the backslash before ASCII punctuation in a link destination, so a
// Windows path like `[report.md](C:\work\.dsh\bot\report.md)` loses the separator in
// front of `.dsh`. Rewrite drive-letter backslash destinations (`C:\...`) to forward
// slashes before Markdown parses them, while leaving code blocks, code spans, link
// titles, UNC paths (`\\server`), and already-forward-slash destinations (`C:/...`
// that may contain valid Markdown escapes like `\[`) untouched.
export function normalizeFileLinks(text) {
  if (typeof text !== 'string' || !text.includes('](') || !text.includes('\\')) return text
  let out = ''
  let cursor = 0
  let i = 0
  let atLineStart = true
  let canIndentCode = true
  let fence = null

  while (i < text.length) {
    if (atLineStart) {
      const end = lineEnd(text, i)
      const line = text.slice(i, end)
      if (fence !== null) {
        if (fenceClose(line, fence)) fence = null
        i = end
        canIndentCode = false
        continue
      }
      if (isBlankLine(text, i, end)) {
        i = end
        canIndentCode = true
        continue
      }
      const opened = fenceOpen(line)
      if (opened !== null) {
        fence = opened
        i = end
        canIndentCode = false
        continue
      }
      if (canIndentCode && /^(?: {4}|\t)/.test(line)) {
        i = end
        continue
      }
      atLineStart = false
      canIndentCode = false
    }

    const ch = text[i]
    if (ch === '\n') {
      atLineStart = true
      i += 1
      continue
    }

    if (ch === '`' && !isEscaped(text, i)) {
      let ticksEnd = i
      while (ticksEnd < text.length && text[ticksEnd] === '`') ticksEnd += 1
      const spanEnd = findCodeSpanEnd(text, ticksEnd, ticksEnd - i)
      if (spanEnd !== -1) {
        i = spanEnd
        atLineStart = text[i - 1] === '\n'
        continue
      }
      i = ticksEnd
      continue
    }

    if (ch === ']' && text[i + 1] === '(' && !isEscaped(text, i)) {
      const destStart = skipLinkWs(text, i + 2)
      let destInnerStart = destStart
      let destInnerEnd = -1
      let afterDest = -1

      if (text[destStart] === '<') {
        destInnerStart = destStart + 1
        let j = destInnerStart
        while (j < text.length && text[j] !== '>' && text[j] !== '\n' && text[j] !== '\r') {
          if (text[j] === '\\' && j + 1 < text.length && !DRIVE_BACKSLASH_PATH.test(text.slice(destInnerStart, destInnerStart + 3))) {
            j += 2
            continue
          }
          j += 1
        }
        if (text[j] === '>') {
          destInnerEnd = j
          afterDest = j + 1
        }
      } else {
        const isWinDrive = DRIVE_BACKSLASH_PATH.test(text.slice(destStart, destStart + 3))
        let j = destStart
        let depth = 0
        while (j < text.length) {
          const c = text[j]
          if (c === ' ' || c === '\t' || c === '\n' || c === '\r') break
          if (!isWinDrive && c === '\\' && j + 1 < text.length) { j += 2; continue }
          if (c === '(') depth += 1
          else if (c === ')') {
            if (depth === 0) break
            depth -= 1
          }
          j += 1
        }
        if (j > destStart && depth === 0) {
          destInnerEnd = j
          afterDest = j
        }
      }

      if (afterDest !== -1) {
        const linkEnd = skipOptionalTitleAndClose(text, afterDest)
        if (linkEnd !== -1) {
          const dest = text.slice(destInnerStart, destInnerEnd)
          if (DRIVE_BACKSLASH_PATH.test(dest)) {
            out += text.slice(cursor, destInnerStart) + dest.replace(/\\/g, '/')
            cursor = destInnerEnd
          }
          i = linkEnd
          atLineStart = text[i - 1] === '\n'
          continue
        }
      }
    }

    i += 1
  }

  return cursor === 0 ? text : out + text.slice(cursor)
}

export function mentionTarget(event) {
  const anchor = event.target instanceof Element ? event.target.closest(`a[href^="${MENTION_ORIGIN}"]`) : null
  return anchor ? anchor.getAttribute('href').slice(MENTION_ORIGIN.length) : null
}

function clock(ms) {
  return new Date(ms).toLocaleTimeString(dateLocale(), { hour: 'numeric', minute: '2-digit' })
}
const midnight = value => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
const daysBefore = (date, now) => Math.round((midnight(new Date(now)) - midnight(date)) / 86400000)
export function dayLabel(ms) {
  const date = new Date(ms)
  const today = new Date()
  const sameDay = date.toDateString() === today.toDateString()
  return sameDay ? t('Today {time}', { time: clock(ms) }) : `${date.toLocaleDateString(dateLocale(), { weekday: 'short', month: 'short', day: 'numeric' })} ${clock(ms)}`
}

// The time separator's stamp: "Today 1:12 AM", "Yesterday 9:03 PM", "Thu, Sep 3 4:20 PM".
export function clockLabel(time, now = Date.now()) {
  const date = new Date(time)
  const days = daysBefore(date, now)
  const stamp = clock(time)
  if (days === 0) return t('Today {time}', { time: stamp })
  if (days === 1) return t('Yesterday {time}', { time: stamp })
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return `${date.toLocaleDateString(dateLocale(), { weekday: 'short', month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })} ${stamp}`
}

// A message's own stamp: today only the clock, an earlier day named as a separator does.
export function messageClock(time, now = Date.now()) {
  return daysBefore(new Date(time), now) === 0 ? clock(time) : clockLabel(time, now)
}

// A short relative stamp for list rows: "just now", "5 min", "3 h", "2 d", then a date.
export function relativeShort(ms) {
  const diff = Math.max(0, Date.now() - ms)
  if (diff < 60_000) return t('just now')
  if (diff < 3_600_000) return t('{n} min', { n: Math.floor(diff / 60_000) })
  if (diff < 86_400_000) return t('{n} h', { n: Math.floor(diff / 3_600_000) })
  if (diff < 30 * 86_400_000) return t('{n} d', { n: Math.floor(diff / 86_400_000) })
  return new Date(ms).toLocaleDateString(dateLocale(), { month: 'short', day: 'numeric' })
}

// A running clock: "8s", "1m 8s", "1h 2m 8s", in every language.
export function elapsedLabel(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  return `${hours > 0 ? `${hours}h ` : ''}${total >= 60 ? `${Math.floor(total / 60) % 60}m ` : ''}${total % 60}s`
}

// A model that writes its tool call in DSML form can leave the closing tags in
// the text block DSH hands the chat. They are wire syntax, not part of the reply.
const DSML_CLOSING_TAG = /<\/DSML\s+(?:invoke|calls)\s*>/i
const DSML_EDGE_TOP = /^(?:[ \t]*<\/DSML\s+(?:invoke|calls)\s*>[ \t]*(?:\r?\n|$))+/i
const DSML_EDGE_END = /(?:\r?\n[ \t]*<\/DSML\s+(?:invoke|calls)\s*>[ \t]*)+$/i
const DSML_TAG_LINE = /\r?\n[ \t]*<\/DSML\s+(?:invoke|calls)\s*>[ \t]*(?=\r?\n)/gi
const DSML_TAG_INLINE = /[ \t]*<\/DSML\s+(?:invoke|calls)\s*>[ \t]*/gi
export const stripToolCallTags = (text) => {
  const value = String(text ?? '')
  if (!DSML_CLOSING_TAG.test(value)) return value
  return value
    .replace(DSML_EDGE_TOP, '')
    .replace(DSML_EDGE_END, '')
    .replace(DSML_TAG_LINE, '')
    .replace(DSML_TAG_INLINE, (match, offset, whole) => {
      const before = offset > 0 ? whole[offset - 1] : ''
      const after = whole[offset + match.length] ?? ''
      return before && after && !/\s/.test(before) && !/\s/.test(after) ? ' ' : ''
    })
}
export const contentText = content => (content ?? [])
  .filter(block => block?.type === 'text')
  .map(block => (typeof block.text === 'string' ? stripToolCallTags(block.text) : ''))
  .join('\n')
// A name can contain brackets. Generated headers end at the newline; without a
// newline, a legacy inline header still stops at its first closing bracket.
export const HEADER = /^\[(Message from|Reply from|Group chat|Group post from|Bot team setup|Handoff · part|Secret card)(?:[^\r\n]*\]\r?\n|[^\]\r\n]*\])/
export const currentPart = bot => bot.sessionId ?? bot.id
// The prompts in a due scheduled task's message. DSH frames it for the model: one
// task as `reminder_prompt_json: "…"`, several as `reminders_json: [{reminder_prompt}]`.
export function reminderPrompts(text) {
  const one = /^reminder_prompt_json: (.*)$/m.exec(text)
  const batch = /^reminders_json: (.*)$/m.exec(text)
  try {
    const prompts = [...(one ? [JSON.parse(one[1])] : []), ...(batch ? JSON.parse(batch[1]).map(entry => entry.reminder_prompt) : [])]
    return prompts.filter(prompt => typeof prompt === 'string' && prompt.trim() !== '')
  } catch {
    // An unreadable framing shows as the plain "Routine started" line.
    return []
  }
}
export const stripHeader = text => text.replace(HEADER, '')

// Of the Bots in a conversation, the one whose memory changed last, by the host's
// clock: changes reaching one window in the same poll share a `seen` time.
export function latestMemoryChange(news, ids) {
  const at = id => (news?.[id]?.seen ? news[id].at ?? 0 : 0)
  return ids.reduce((best, id) => (at(id) > at(best) ? id : best), ids[0] ?? null)
}

// A memory summary is "## Heading" lines, each over one paragraph; stray Markdown
// marks and list bullets are dropped.
export function summaryBlocks(text) {
  const blocks = []
  let paragraph = []
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: 'p', text: paragraph.join(' ') })
    paragraph = []
  }
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim().replace(/\*\*|__/g, '')
    const heading = /^#{1,6}\s+(.+)$/.exec(line)
    if (heading) {
      flush()
      blocks.push({ kind: 'h', text: heading[1].trim() })
    } else if (line === '') {
      flush()
    } else {
      paragraph.push(line.replace(/^[-*•]\s+/, ''))
    }
  }
  flush()
  return blocks
}

export function isHiddenTurn(roster, sessionId, turn) {
  if (sessionId === undefined || turn === undefined) return false
  return (roster.exchangeTurns[sessionId] ?? []).includes(turn)
}

export const toolName = root => root.name || root.call?.name

export function toolArgs(root) {
  if (typeof root.args?.text === 'function') {
    return { text: key => root.args.text(key) ?? undefined, value: key => (typeof root.args.value === 'function' ? root.args.value(key) : undefined) }
  }
  let parsed
  const object = () => {
    if (parsed === undefined) {
      try { parsed = JSON.parse(root.argsRaw ?? root.call?.argsRaw ?? '') } catch { parsed = null }
      if (typeof parsed !== 'object' || Array.isArray(parsed)) parsed = null
    }
    return parsed
  }
  return {
    text: (key) => { const value = object()?.[key]; return typeof value === 'string' ? value : undefined },
    value: key => object()?.[key],
  }
}

// A relay context is a Bot-to-Bot request, reply or stop notice injected into the
// model's history. ds-bot's own package sources (kickoff, room, secret, handoff
// parts) are not events in the chat, nor is a request handed back after its line was
// already shown: deferred, resumed after a restart, or retried after a tool call
// written as text.
const RELAY_ROLES = new Set(['request', 'reply', 'stopped'])
export const isRelayContext = (data) => {
  const source = data?.source
  if (source === null || typeof source !== 'object' || source.kind !== 'bot' || source.handoff === true) return false
  if (source.deferred === true || source.resumed === true || source.retried === true) return false
  return RELAY_ROLES.has(source.role) && typeof source.senderSessionId === 'string'
}

// 'context' chat nodes never reach the flow on DSH 0.2, so a relay spliced into
// a running turn would be invisible; the step that answers it renders the line.
// A relay attaches to the next step that renders a cell: tool-only steps mount
// nothing (ui-chat gives them no visible node), so `prev` is the previous step
// with visible content, not the previous step in the list.
// `contexts` and `steps` are the turn's turnDataSource lists (anchor order) and
// `step` is the rendering step's own data. A step is found by its number: the
// cell's node data and the source's entries can be different snapshot objects.
const stepShows = (step) => (step?.blocks ?? []).some(block => {
  // ui-chat's mount rule for a step node: non-empty reasoning, or reply content
  // (`hasAssistantReplyContent`); a tool call alone keeps the node hidden.
  if (block === undefined || block.kind === 'tool-call') return false
  return block.kind === 'text' || block.kind === 'reasoning' ? String(block.text ?? '').trim() !== '' : true
})
const stepHasReasoning = (step) => (step?.blocks ?? []).some(block => block?.kind === 'reasoning' && String(block.text ?? '').trim() !== '')
// The step's own cells: a reasoning step emits a 'reasoning' part and a step
// with reply content a 'response' part, or both. The line belongs in the first
// of them — before the thinking row, else before the reply.
export const relayPart = (data, groupPart) => groupPart === undefined || (stepHasReasoning(data) ? groupPart === 'reasoning' : groupPart === 'response')
export function relaysBefore(contexts, steps, step) {
  const index = steps.findIndex(entry => entry?.step === step?.step)
  if (index === -1) return []
  let prev = -Infinity
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (stepShows(steps[cursor])) { prev = steps[cursor].time; break }
  }
  // The lower bound is inclusive: a relay steered right after the previous
  // step's assistant/message can share its millisecond, and it still belongs to
  // this step — its own model call follows the previous one. The upper bound
  // stays strict: a step's time is its settled message or first visible token.
  return (contexts ?? []).filter(data => isRelayContext(data) && typeof data.time === 'number' && data.time >= prev && data.time < step.time)
}

// Back-to-back Bot-to-Bot messages fold into one "N messages with" line. A
// hidden exchange turn holds a request and its reply; a visible one (a reply, or a
// request answered to the user) adds only its trigger and ends the run. Group turns
// never show in a one-to-one chat, so they do not break a run.
// `order` lists the Session's turns; `peers` maps each relayed turn to its sender's id.
// Returns null (unknown), 'folded', or { count, peerIds } for the run's first line.
export function commRunOf(order, peers, turn, hiddenTurns = []) {
  const turns = []
  for (const entry of order) {
    const peer = peers[entry]
    const hidden = hiddenTurns.includes(entry)
    if (hidden && peer === undefined) continue
    turns.push({ turn: entry, peer, hidden })
  }
  const at = turns.findIndex(entry => entry.turn === turn)
  if (at === -1 || turns[at].peer === undefined) return null
  const previous = turns[at - 1]
  if (previous?.peer !== undefined && previous.hidden) return 'folded'
  let count = 0
  const peerIds = []
  for (let index = at; index < turns.length; index += 1) {
    const entry = turns[index]
    if (entry.peer === undefined || (index > at && !turns[index - 1].hidden)) break
    count += entry.hidden ? 2 : 1
    if (!peerIds.includes(entry.peer)) peerIds.push(entry.peer)
  }
  return { count, peerIds }
}

// Latest visible line for a sidebar row; Bot-to-Bot exchange turns stay out of it.
export function previewOf(list, id, hiddenTurns = []) {
  const outline = list.projectionsBySession?.[id]?.values?.turnOutline ?? list.byId[id]?.projectionValues?.turnOutline
  if (!Array.isArray(outline)) return ''
  for (let index = outline.length - 1; index >= 0; index -= 1) {
    const entry = outline[index]
    if (hiddenTurns.includes(entry.turn)) continue
    const text = entry.response || entry.prompt || ''
    if (text !== '') return stripHeader(text).replace(/\s+/g, ' ').trim()
  }
  return ''
}

const formatTokens = count => (count >= 1e6 ? `${(count / 1e6).toFixed(1)}M` : count >= 1e3 ? `${(count / 1e3).toFixed(1)}K` : String(count))

// Same buckets as the shell's usage pill: every prompt-side billing bucket plus output.
export function usageOf(list, ids) {
  let input = 0
  let cacheRead = 0
  let output = 0
  for (const id of ids) {
    const usage = list.projectionsBySession?.[id]?.values?.tokenUsage
    if (!usage) continue
    input += (usage.uncachedInputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
    cacheRead += usage.cacheReadTokens ?? 0
    output += usage.outputTokens ?? 0
  }
  if (input + output === 0) return ''
  const hit = input > 0 ? Math.round((cacheRead / input) * 100) : 0
  return t('{tokens} tok · Cache hit {hit}%', { tokens: formatTokens(input + output), hit })
}

// A share that is not whole never reads as 100%: it gets decimals until it does not.
function percentText(part, whole) {
  if (part >= whole) return '100'
  for (let places = 0; places < 3; places += 1) {
    const text = ((part / whole) * 100).toFixed(places)
    if (Number(text) < 100) return text
  }
  return '99.99'
}

// One Session's figures from DSH's sessionStats, tokenUsage and contextPressure views, as
// its status bar counts them: turns, output tokens over decode time, cache reads over
// every prompt-side token, and the context in use. Figures with nothing to count yet are left out.
export function runStatsOf(values) {
  const stats = values?.sessionStats
  const usage = values?.tokenUsage
  const pressure = values?.contextPressure
  const shown = []
  if (stats?.turns > 0) shown.push({ key: 'turns', text: stats.turns === 1 ? t('1 turn') : t('{count} turns', { count: stats.turns }) })
  if (stats?.decodeMs > 0 && stats.decodeTokens > 0) {
    const speed = stats.decodeTokens / (stats.decodeMs / 1000)
    shown.push({ key: 'speed', text: t('{speed} tok/s', { speed: speed >= 10 ? Math.round(speed) : Math.round(speed * 10) / 10 }) })
  }
  const prompt = (usage?.uncachedInputTokens ?? 0) + (usage?.cacheReadTokens ?? 0) + (usage?.cacheWriteTokens ?? 0)
  if (prompt > 0) shown.push({ key: 'cache', text: t('Cache hit {hit}%', { hit: percentText(usage.cacheReadTokens ?? 0, prompt) }) })
  const used = pressure?.projectedTokens ?? pressure?.pressureTokens
  if (Number.isFinite(used) && pressure.contextWindow > 0) {
    shown.push({
      key: 'context',
      text: t('Context {percent}%', { percent: Math.min(100, Math.round((used / pressure.contextWindow) * 100)) }),
      title: t('{used} of {total} tokens of context in use', { used: formatTokens(used), total: formatTokens(pressure.contextWindow) }),
    })
  }
  return shown
}
