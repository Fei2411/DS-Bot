// Unified context rebuilder for DS Bot (D3 / B5).
//
// Consolidates the six context-packing paths across parts.js, local-agents/adapter.js,
// bot-tasks.js, and chat-index.js onto one budget-aware, recency-first foundation:
//   - extractToolTrail: redacted recent tool calls + outcomes (with call_id for recall)
//   - buildHandoffPack: part-switch recent messages + earlier anchored list
//   - buildCheckpointPack: checkpoint verbatim recent tail + messages to the Bot
//   - buildReplayPack: local CLI fresh-session replay blocks
//   - buildCompactDigest: deterministic fallback compaction digest for local CLIs
//   - buildFallbackContext: non-forked background task recent-context summary
//   - formatOwnChatBrief: private-chat brief injected into a fresh group session
import { REPLY_KIND } from './constants.js'
import { utf8Bytes } from './handoff-budget.js'
import { clip as clipText, estimateTokens as defaultEstimateTokens, textOf } from './text.js'

const DEFAULT_TOOL_SKIP = new Set(['ask_user', 'show_view', 'request_secret', 'group_relay'])
const DEFAULT_TOOL_ARG_KEYS = ['path', 'file_path', 'file', 'target', 'command', 'cmd', 'query', 'pattern', 'url', 'to', 'task', 'topic', 'dir', 'cwd', 'title']

export function normalizeSingleLine(text, maxChars = 1_000) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length <= maxChars) return flat
  return `${flat.slice(0, Math.max(0, maxChars))}…`
}

export function toolArgSummary(rawArgs, { redact = value => String(value ?? ''), argKeys = DEFAULT_TOOL_ARG_KEYS } = {}) {
  let args = rawArgs
  if (typeof args === 'string') {
    try { args = JSON.parse(args) } catch { return redact(args).replace(/\s+/g, ' ').trim().slice(0, 120) }
  }
  if (args === null || typeof args !== 'object') return ''
  for (const key of argKeys) {
    const val = args[key]
    if (typeof val === 'string' && val.trim() !== '') {
      const clean = redact(val).replace(/\s+/g, ' ').trim()
      return clean.length > 120 ? `${clean.slice(0, 120)}…` : clean
    }
  }
  return ''
}

// Walks events newest-first (async iterable or array) and builds a redacted,
// budget-bounded trail of recent tool calls and outcomes, oldest first.
// Appends `[call_id: ...]` when a callId is present so pruned/archived outputs
// remain recallable via `read_own_chat({ call_id })`.
// Only surface replacement events (`surfaceOp.op === 'replace'`) are pruned
// replacements; ordinary DSH `tool/result` events also carry `sourceEventSeqs`
// pointing at their originating `tool/call` event and must NOT be skipped.
export const isReplacementToolResult = event => event?.surfaceOp?.op === 'replace'

export async function extractToolTrail(events, {
  maxCalls = 18,
  maxTokens = 1_500,
  skipNames = DEFAULT_TOOL_SKIP,
  argKeys = DEFAULT_TOOL_ARG_KEYS,
  redact = value => String(value ?? ''),
  clock = () => '',
  estimateTokens = defaultEstimateTokens,
} = {}) {
  if (maxCalls <= 0 || maxTokens <= 0) return []
  const results = new Map()
  const entries = []
  let used = 0
  try {
    for await (const event of events) {
      if (event.type === 'tool/result') {
        if (isReplacementToolResult(event)) continue
        const message = event.data?.message
        const callId = message?.toolCallId
        if (typeof callId === 'string' && !results.has(callId)) {
          const failed = message.ok === false || message.isError === true
          const detail = failed ? redact(textOf(message.content)).replace(/\s+/g, ' ').trim().slice(0, 120) : ''
          results.set(callId, failed ? (detail ? `error: ${detail}` : 'error') : 'ok')
        }
        continue
      }
      if (event.type !== 'tool/call') continue
      const name = event.data?.name
      if (typeof name !== 'string' || skipNames.has(name)) continue
      const arg = toolArgSummary(event.data?.arguments, { redact, argKeys })
      const callId = typeof event.data?.callId === 'string' && event.data.callId !== '' ? event.data.callId : undefined
      const outcome = callId !== undefined ? results.get(callId) : undefined
      const head = arg === '' ? name : `${name}(${arg})`
      const idTag = callId !== undefined ? ` [call_id: ${callId}]` : ''
      const line = `- [${clock(event.time)}] ${head}${outcome === undefined ? '' : ` -> ${outcome}`}${idTag}`
      const cost = estimateTokens(line)
      if (entries.length > 0 && used + cost > maxTokens) break
      entries.push(line)
      used += cost
      if (entries.length >= maxCalls) break
    }
  } catch {
    return entries.reverse()
  }
  return entries.reverse()
}

// Part-switch handoff packer: newest messages verbatim within `budget`, followed
// (in own chat) by an anchored list of earlier messages to the Bot within `listBudget`.
export async function buildHandoffPack({
  lines,
  budget,
  listBudget,
  recentLineMax = 4_000,
  listLineMax = 400,
  group = false,
  number = 1,
  clock = () => '',
  clip = clipText,
  estimateTokens = defaultEstimateTokens,
}) {
  const recent = []
  const earlier = []
  let used = 0
  let full = false
  let listed = 0
  let unlisted = 0
  const stamp = line => (group ? `[${clock(line.time)}]` : `[part ${number} #${line.seq} · ${clock(line.time)}]`)
  for await (const line of lines) {
    if (!full) {
      const text = clip(line.text, recentLineMax, group ? 'the full text is in the saved record' : `read_own_chat around "part ${number} #${line.seq}" shows all of it`)
      const cost = estimateTokens(text)
      if (recent.length === 0 || used + cost <= budget) {
        recent.push(`${stamp(line)} ${text}`)
        used += cost
        continue
      }
      full = true
    }
    if (group) break
    if (line.who === 'you') continue
    const text = clip(line.text, listLineMax, `read_own_chat around "part ${number} #${line.seq}" shows all of it`)
    const cost = estimateTokens(text)
    if (unlisted > 0 || listed + cost > listBudget) {
      unlisted += 1
      continue
    }
    earlier.push(`${stamp(line)} ${text}`)
    listed += cost
  }
  return { recent: recent.reverse(), earlier: earlier.reverse(), unlisted, full }
}

// Checkpoint packer: preserves messages to the Bot (and optionally the latest
// user+Bot exchanges verbatim when the backend did not retain a multi-message tail).
export async function buildCheckpointPack({
  lines,
  budget,
  recentLineMax = 4_000,
  toolMaxTokens = 1_500,
  group = false,
  number = 1,
  includeRecent = false,
  tailText = '',
  clock = () => '',
  clip = clipText,
  estimateTokens = defaultEstimateTokens,
  read,
  onKept,
}) {
  const recent = []
  const kept = []
  const recentBudget = includeRecent ? Math.floor(budget * 0.5) : 0
  const toolBudget = includeRecent ? Math.min(toolMaxTokens, Math.floor(budget * 0.15)) : 0
  const keptBudget = Math.max(0, budget - recentBudget - toolBudget)
  let recentUsed = 0
  let recentFull = !includeRecent
  let keptUsed = 0
  let more = false
  let skippedTail = false
  const stamp = line => (group ? `[${clock(line.time)}]` : `[part ${number} #${line.seq} · ${clock(line.time)}]`)
  for await (const line of lines) {
    // Skip duplicating the single assistant reply DSH already kept verbatim right
    // after the checkpoint on the surface.
    if (includeRecent && !skippedTail && tailText !== '' && line.who === 'you' && line.text === `You: ${tailText}`) {
      skippedTail = true
      continue
    }
    if (!recentFull) {
      const text = `${stamp(line)} ${clip(line.text, recentLineMax, 'read_own_chat shows all of it')}`
      const cost = estimateTokens(text)
      if (recent.length === 0 || recentUsed + cost <= recentBudget) {
        recent.push(text)
        onKept?.()
        recentUsed += cost
        if (read?.capped) {
          more = true
          break
        }
        continue
      }
      recentFull = true
    }
    if (line.who === 'you') continue
    const text = `${stamp(line)} ${clip(line.text, recentLineMax, 'read_own_chat shows all of it')}`
    const cost = estimateTokens(text)
    if ((kept.length > 0 || recent.length > 0) && keptUsed + cost > keptBudget) {
      more = true
      break
    }
    kept.push(text)
    onKept?.()
    keptUsed += cost
    if (read?.capped) {
      more = true
      break
    }
  }
  more ||= read?.complete !== true
  return { recent: recent.reverse(), kept: kept.reverse(), more, toolBudget }
}

// Local CLI fresh-session replay packer: optional team instructions (for ACP),
// fresh memory snapshots, and bounded recent messages with current unread input,
// latest memory snapshots, and latest handoff kept verbatim.
export async function buildReplayPack({
  messages,
  system = '',
  resolveImage,
  blocksOfMessage,
  mergeTextBlocks,
  preserve = [],
  freshMemory,
  memoryNote = '',
  includeSystem = true,
  isClockSource,
  ownMemorySource,
  groupMemorySource,
  memoryUpdateSource,
  ownHeading,
  limits = {},
}) {
  const replayMessages = limits.messages ?? 12
  const replayTotalMax = limits.totalMax ?? 36
  const replayBytes = limits.bytes ?? 24 * 1024
  const replayLineMax = limits.lineMax ?? 2_000
  const memUpdateMax = limits.memoryUpdateMax ?? 6
  const memUpdateBytes = limits.memoryUpdateBytes ?? 8 * 1024

  const picked = []
  let used = 0
  let conversationCount = 0
  let memoryUpdates = 0
  let memoryUpdateBytes = 0
  const body = (messages ?? []).filter(message => message.role !== 'system')
  const latest = body.at(-1)
  const latestNonClock = [...body].reverse().find(message => !isClockSource(message.source))
  const injectFreshOwn = freshMemory?.own !== undefined && !system.includes(ownHeading)
  const latestOwnMem = injectFreshOwn ? undefined : [...body].reverse().find(message => message.source?.kind === ownMemorySource)
  const latestGroupMem = freshMemory?.group !== undefined ? undefined : [...body].reverse().find(message => message.source?.kind === groupMemorySource)
  const latestHandoff = [...body].reverse().find(message => message.source?.handoff === true)
  const preserveSet = new Set(preserve)
  let full = false
  const entryTextBytes = blocks => blocks.reduce((sum, block) => sum + (block?.type === 'text' ? utf8Bytes(block.text) : 0), 0)
  for (const message of [...body].reverse()) {
    const sourceKind = message.source?.kind
    const isCurrentInput = message === latest || message === latestNonClock || preserveSet.has(message)
    if (!isCurrentInput && isClockSource(message.source)) continue
    if (sourceKind === ownMemorySource && message !== latestOwnMem) continue
    if (sourceKind === groupMemorySource && message !== latestGroupMem) continue
    const prefix = `${message.role === 'assistant' ? 'You' : message.role === 'tool' ? `Tool result (${message.toolCallId ?? 'call'})` : 'User'}:`
    if (sourceKind === memoryUpdateSource) {
      if (freshMemory !== undefined) continue
      if (memoryUpdates >= memUpdateMax || (memoryUpdates > 0 && memoryUpdateBytes >= memUpdateBytes)) continue
      const maxBytes = Math.max(500, memUpdateBytes - memoryUpdateBytes)
      const blocks = await blocksOfMessage(message, { maxBytes, maxText: maxBytes, resolveImage, includeToolCalls: true })
      if (blocks.length === 0) continue
      const entry = blocks[0].type === 'text'
        ? [{ type: 'text', text: `${prefix} ${blocks[0].text}` }, ...blocks.slice(1)]
        : [{ type: 'text', text: prefix }, ...blocks]
      const entryBytes = entryTextBytes(entry)
      if (memoryUpdates > 0 && memoryUpdateBytes + entryBytes > memUpdateBytes) continue
      picked.unshift(entry)
      memoryUpdates += 1
      memoryUpdateBytes += entryBytes
      continue
    }
    const whole = isCurrentInput || message === latestHandoff || message === latestOwnMem || message === latestGroupMem
    if (!whole) {
      full ||= conversationCount >= replayMessages || picked.length >= replayTotalMax || used + utf8Bytes(prefix) + 1 > replayBytes
      if (full) continue
    }
    const cap = whole ? Infinity : replayLineMax
    const blocks = await blocksOfMessage(message, { maxBytes: cap, maxText: cap, resolveImage, includeToolCalls: true })
    if (blocks.length === 0 && !whole) continue
    const entry = blocks.length > 0 && blocks[0].type === 'text'
      ? [{ type: 'text', text: `${prefix} ${blocks[0].text}` }, ...blocks.slice(1)]
      : blocks.length > 0
        ? [{ type: 'text', text: prefix }, ...blocks]
        : [{ type: 'text', text: `${prefix} ` }]
    const entryBytes = entryTextBytes(entry)
    if (!whole && used + entryBytes > replayBytes) {
      full = true
      continue
    }
    picked.unshift(entry)
    if (!whole) used += entryBytes
    if (message.role !== 'tool' && sourceKind !== ownMemorySource && sourceKind !== groupMemorySource && !isClockSource(message.source)) {
      conversationCount += 1
    }
  }
  if (picked.length === 0) return []
  const headerParts = []
  if (includeSystem && system !== '') headerParts.push(`The team instructions for this conversation:\n${system}`)
  if (memoryNote !== '') headerParts.push(memoryNote)
  if (injectFreshOwn) headerParts.push(freshMemory.own)
  if (freshMemory?.group !== undefined) headerParts.push(freshMemory.group)
  headerParts.push('The conversation so far (oldest first):')
  return mergeTextBlocks([{ type: 'text', text: headerParts.join('\n\n') }, ...picked.flat()])
}

// Deterministic condensation digest for non-model local CLI compaction requests.
export function buildCompactDigest(messages, { maxBytes = 8 * 1024, maxLineChars = 300 } = {}) {
  const lines = []
  let used = 0
  for (const message of [...(messages ?? [])].reverse()) {
    if (message?.role === 'system') continue
    const text = textOf(message.content).replace(/\s+/g, ' ').trim()
    if (text === '') continue
    const line = `${message.role}: ${text.slice(0, maxLineChars)}`
    if (lines.length > 0 && used + line.length > maxBytes) break
    lines.push(line)
    used += line.length
  }
  return `[Earlier conversation, condensed]\n${lines.reverse().join('\n')}`
}

function clipRecentText(text, max) {
  const value = String(text ?? '').trim()
  if (value.length <= max) return value
  if (max <= 0) return ''
  const lines = value.split('\n')
  const kept = []
  let chars = 0
  let truncated = false
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]
    const extra = kept.length === 0 ? line.length : line.length + 1
    if (kept.length > 0 && chars + extra > max) {
      truncated = true
      break
    }
    const entry = kept.length === 0 && line.length > max
      ? `…${line.slice(Math.max(0, line.length - Math.max(1, max - 1)))}`
      : line
    if (entry !== line) truncated = true
    kept.push(entry)
    chars += kept.length === 1 ? entry.length : entry.length + 1
  }
  const body = kept.reverse().join('\n')
  return truncated && !body.startsWith('…') ? `…\n${body}` : body
}

// Bounded recent-context note for non-forked background tasks and local CLI
// foreground-to-background handoffs, preserving the latest [Handoff]/[Checkpoint]
// structured note with headings intact alongside the most recent messages.
export function buildFallbackContext({
  events,
  label = 'your own chat',
  maxChars = 4_000,
  noteMinChars = 1_500,
  maxItems = 8,
  lineMax = 1_000,
  maxSeq,
  excludeTurns,
  sourceKind,
  handoffAck = '',
  cleanStructuredNote = value => String(value ?? '').trim(),
  clipStructuredNote = (note, max) => (note.length <= max ? note : `${note.slice(0, max)}…`),
}) {
  if (!Array.isArray(events) || events.length === 0) return ''
  const excluded = excludeTurns instanceof Set && excludeTurns.size > 0 ? excludeTurns : undefined
  const boundedEvents = Number.isInteger(maxSeq)
    ? events.filter(event => !Number.isInteger(event?.seq) || event.seq <= maxSeq)
    : events
  if (boundedEvents.length === 0) return ''
  let latestNote = ''
  let latestNoteStructured = false
  let shadowedEnd = -1
  for (const event of boundedEvents) {
    if (event.type === 'compaction/summary') {
      const cleaned = cleanStructuredNote(event.data?.summary)
      if (cleaned !== '') {
        latestNote = cleaned
        latestNoteStructured = true
      }
      if (Number.isInteger(event.data?.shadowedRange?.end) && event.data.shadowedRange.end > shadowedEnd) {
        shadowedEnd = event.data.shadowedRange.end
      }
    } else if (event.type === 'user/message' && event.data?.source?.kind === sourceKind && event.data.source.handoff === true) {
      const raw = textOf(event.data?.message?.content ?? event.data?.content ?? '').trim()
      const cleaned = cleanStructuredNote(raw, { handoff: true })
      if (cleaned !== '') {
        latestNote = cleaned
        latestNoteStructured = true
      }
    } else if (event.type === 'user/message' && event.data?.source?.kind === sourceKind && event.data.source.carriedContext === true) {
      const raw = textOf(event.data?.message?.content ?? event.data?.content ?? '').trim()
      const marker = raw.match(/\[Recent context from [^\]]+\]\s*/i)
      const stripped = (marker ? raw.slice(marker.index + marker[0].length) : raw).trim()
      if (stripped !== '') {
        latestNote = stripped
        latestNoteStructured = /^##\s+/m.test(stripped)
      }
    }
  }
  const lines = []
  let activeTurn
  for (const event of boundedEvents) {
    if (event.type === 'turn/start' && Number.isInteger(event.data?.turn)) {
      activeTurn = event.data.turn
      continue
    }
    if (event.type === 'turn/end') {
      activeTurn = undefined
      continue
    }
    if (excluded !== undefined && activeTurn !== undefined && excluded.has(activeTurn)) continue
    if (shadowedEnd >= 0 && Number.isInteger(event.seq) && event.seq <= shadowedEnd) continue
    if (event.type === 'user/message') {
      const source = event.data?.source
      const kind = source?.kind
      // Only carry real conversation messages: skip DSH/plugin context injections
      // (memory snapshots/updates/recalls, clock/time samples, workspace instructions,
      // skill catalogs, runtime-context, compact-checkpoint) and internal notices.
      const allowed = kind === undefined || kind === 'user' || kind === REPLY_KIND || kind === 'schedule' || kind === sourceKind
      if (!allowed) continue
      if (kind === sourceKind && (source.handoff === true || source.role === 'task-handoff' || source.role === 'kickoff' || source.role === 'goal' || (source.role === 'request' && source.audience !== 'user'))) continue
      const text = textOf(event.data?.message?.content ?? event.data?.content ?? '').trim()
      if (text !== '' && !text.startsWith('<system-reminder>')) lines.push(`User: ${normalizeSingleLine(text, lineMax)}`)
    } else if (event.type === 'assistant/message') {
      const text = textOf(event.data?.message?.content ?? []).trim()
      if (text !== '' && text !== handoffAck) lines.push(`Assistant: ${normalizeSingleLine(text, lineMax)}`)
    }
  }
  if (latestNote === '' && lines.length === 0) return ''
  const tailBudget = latestNote === ''
    ? maxChars
    : Math.max(0, maxChars - Math.min(latestNote.length, noteMinChars) - 2)
  const selected = []
  let chars = 0
  let truncated = false
  const tail = lines.slice(-maxItems)
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const line = tail[i]
    const extra = selected.length === 0 ? line.length : line.length + 1
    if (tailBudget === 0) {
      truncated = true
      break
    }
    if (selected.length > 0 && chars + extra > tailBudget) {
      truncated = true
      break
    }
    const kept = selected.length === 0 && line.length > tailBudget
      ? `${line.slice(0, tailBudget)}…`
      : line
    selected.push(kept)
    chars += selected.length === 1 ? kept.length : kept.length + 1
  }
  truncated ||= lines.length > maxItems
  const tailBody = selected.reverse().join('\n')
  const clippedTail = tailBody === '' ? '' : (truncated ? `…\n${tailBody}` : tailBody)
  let body
  if (latestNote !== '') {
    const noteBudget = clippedTail === ''
      ? maxChars
      : Math.max(noteMinChars, maxChars - clippedTail.length - 2)
    const keptNote = latestNoteStructured
      ? clipStructuredNote(latestNote, noteBudget)
      : clipRecentText(latestNote, noteBudget)
    body = clippedTail === '' ? keptNote : `${keptNote}\n\n${clippedTail}`
  } else {
    body = clippedTail
  }
  return `\n\n[Recent context from ${label}]\n${body}`
}

// Private-chat brief injected when opening a member's fresh group Session.
export function formatOwnChatBrief(lines = []) {
  return [
    'Your own chat with the user so far (latest messages, oldest first; private, so share only what the group needs):',
    lines.length > 0 ? lines.join('\n') : 'Nothing yet.',
    'This brief does not change. Call read_own_chat when you need something newer or older from your own chat.',
  ].join('\n')
}
