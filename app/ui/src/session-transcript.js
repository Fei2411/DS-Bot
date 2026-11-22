// Projects a SessionLog (ds-bot/src/client/session-log.js) into ordered display rows
// for a Bot's own chat (current segment): user messages, assistant replies with thinking
// and local-agent activity, paired tool calls (preparing -> start -> result, plus nested
// sub-calls), compaction checkpoints, Bot/schedule events, and failed turns.
import { transcriptOf, writingBlocks } from '../../../ds-bot/src/client/session-log.js'
import { contentText, isHiddenTurn, reminderPrompts, stripToolCallTags } from '../../../ds-bot/src/client/text.js'
import { contentParts, viaOf } from '../../../ds-bot/src/client/user-message.js'

const ACTIVITY_PREFIX = '▸ '

// Strips a leading `<signature>...</signature>` reasoning prefix meant for the model,
// matching ds-bot/src/client/turn-reasoning.js.
function visibleReasoning(text) {
  if (typeof text !== 'string' || text === '') return ''
  if (text[0] !== '<') return text
  if ('<signature>'.startsWith(text)) return ''
  if (!text.startsWith('<signature>')) return text
  const end = text.indexOf('</signature>')
  return end === -1 ? '' : text.slice(end + '</signature>'.length).replace(/^(\r?\n)+/, '')
}

export function splitReasoning(blocks) {
  const joined = (Array.isArray(blocks) ? blocks : [])
    .filter(block => block?.type === 'reasoning' && typeof block.text === 'string')
    .map(block => visibleReasoning(block.text))
    .join('\n')
  if (!joined) return { reasoning: '', activity: [] }
  const thought = []
  const activity = []
  for (const line of joined.split('\n')) {
    if (line.startsWith(ACTIVITY_PREFIX)) {
      const text = line.slice(ACTIVITY_PREFIX.length).trim()
      if (text) activity.push(text)
    } else {
      thought.push(line)
    }
  }
  return { reasoning: thought.join('\n').trim(), activity }
}

// Exact reasoning span from DSH's timed compact stream on a committed assistant/message
// (same calculation as ds-bot/src/host/thinking.js).
export function streamReasoningMs(stream) {
  let first
  let last
  for (const record of Array.isArray(stream) ? stream : []) {
    if (record?.type !== 'reasoning-chunks' || !Array.isArray(record.texts) || record.texts.length === 0) continue
    const end = (Array.isArray(record.dt) ? record.dt : []).reduce((time, gap) => time + gap, record.time0)
    if (first === undefined || record.time0 < first) first = record.time0
    if (last === undefined || end > last) last = end
  }
  return first === undefined ? undefined : Math.max(0, last - first)
}

// Lazy argument reader matching DSH's ToolArgs contract (`text(key)` / `value(key)` / `raw`).
export function makeToolArgs(raw) {
  const rawStr = typeof raw === 'string' ? raw : (raw === undefined || raw === null ? '' : JSON.stringify(raw))
  let parsed
  let didParse = false
  const parse = () => {
    if (!didParse) {
      didParse = true
      if (rawStr.trim() === '') { parsed = null; return parsed }
      try { parsed = JSON.parse(rawStr) } catch { parsed = null }
    }
    return parsed
  }
  const object = () => {
    const value = parse()
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
  }
  return {
    raw: rawStr,
    parsed: parse,
    text: (key) => {
      const value = object()?.[key]
      return typeof value === 'string' ? value : undefined
    },
    value: key => object()?.[key],
  }
}

const HIDDEN_BOT_ROLES = new Set(['kickoff', 'room', 'goal', 'task-handoff', 'handback', 'secret'])

function classifyUserMessage(event, { turn, roster, sessionId }) {
  const data = event.data ?? {}
  const source = data.source !== null && typeof data.source === 'object' ? data.source : {}
  const content = Array.isArray(data.content) ? data.content : []
  if (source.kind === 'user') {
    const { text, attachments, rest } = contentParts(content)
    const via = viaOf(source) ?? roster?.imVia?.[sessionId]?.[event.seq]
    if (text === '' && attachments.length === 0 && rest.length === 0) return null
    return {
      kind: 'user',
      key: `user:${event.seq}`,
      seq: event.seq,
      time: event.time,
      turn,
      text,
      attachments,
      rest,
      content,
      ...(via ? { via } : {}),
      source,
    }
  }
  if (source.kind === 'bot') {
    if (source.handoff === true) return { kind: 'part-start', key: `part:${event.seq}`, seq: event.seq, time: event.time }
    if (HIDDEN_BOT_ROLES.has(source.role) || source.deferred === true) return null
    if (source.role === 'update') return { kind: 'event', key: `ev:${event.seq}`, seq: event.seq, time: event.time, eventKind: 'update' }
    if (source.role === 'resume' || source.resumed === true) return { kind: 'event', key: `ev:${event.seq}`, seq: event.seq, time: event.time, eventKind: 'resume' }
    if (source.role === 'retry' || source.retried === true) return { kind: 'event', key: `ev:${event.seq}`, seq: event.seq, time: event.time, eventKind: 'retry' }
    if (source.role === 'continue') return { kind: 'event', key: `ev:${event.seq}`, seq: event.seq, time: event.time, eventKind: 'continue' }
    if (source.role === 'report') return { kind: 'event', key: `ev:${event.seq}`, seq: event.seq, time: event.time, eventKind: 'report', roomId: source.roomId }
    if (source.role === 'request' || source.role === 'reply' || source.role === 'stopped') {
      return {
        kind: 'event',
        key: `ev:${event.seq}`,
        seq: event.seq,
        time: event.time,
        eventKind: source.role,
        botId: source.senderSessionId ?? null,
        name: source.senderName ?? null,
      }
    }
    return null
  }
  if (source.kind === 'schedule') {
    const prompts = reminderPrompts(contentText(content))
    return {
      kind: 'event',
      key: `ev:${event.seq}`,
      seq: event.seq,
      time: event.time,
      eventKind: 'schedule',
      text: prompts.join(' · ').slice(0, 80),
    }
  }
  // System injections (agent-instructions, runtime-context, skill-catalog, time-context,
  // goal, user-question-reply) never render as user bubbles.
  return null
}

function turnEndFailure(reason) {
  if (!reason || typeof reason !== 'object') return undefined
  if (reason.kind === 'error') return reason.error ?? {}
  if (reason.kind === 'aborted' && reason.reason?.kind === 'hook' && reason.reason?.reason === 'deepseek-account/signed-out') {
    return { code: 'ACCOUNT_SIGNED_OUT', message: 'Stopped because you signed out of DeepSeek.' }
  }
  if (reason.kind === 'interrupted') {
    return { code: 'INTERRUPTED', message: 'The DSH process exited before this turn finished.' }
  }
  return undefined
}

/**
 * Converts a SessionLog into ordered display rows for a DM chat.
 * @param {import('../../../ds-bot/src/client/session-log.js').SessionLog} log
 * @param {{ roster?: object, sessionId?: string }} [options]
 * @returns {object[]}
 */
export function buildSessionRows(log, { roster, sessionId } = {}) {
  const items = transcriptOf(log)
  const rows = []
  const callsById = new Map()
  let currentTurn
  const hidden = turn => (roster?.exchangeTurns && sessionId ? isHiddenTurn(roster, sessionId, turn) : false)

  for (const item of items) {
    if (item.kind === 'compaction') {
      rows.push({
        kind: 'compaction',
        key: `compaction:${item.seq}`,
        seq: item.seq,
        time: item.time,
        compactionId: item.compactionId,
        summary: item.summary,
        shadowedItemCount: item.shadowedItemCount,
        shadowedTokenCount: item.shadowedTokenCount,
      })
      continue
    }

    if (item.type === 'turn/start') {
      if (Number.isInteger(item.data?.turn)) currentTurn = item.data.turn
      continue
    }

    if (item.type === 'turn/end') {
      const turn = item.data?.turn ?? currentTurn
      const failure = turnEndFailure(item.data?.reason)
      if (!hidden(turn) && failure !== undefined) {
        rows.push({
          kind: 'turn-error',
          key: `turn-error:${item.seq}`,
          seq: item.seq,
          time: item.time,
          turn,
          error: failure,
        })
      }
      continue
    }

    if (item.type === 'user/message') {
      const row = classifyUserMessage(item, { turn: item.data?.turn ?? currentTurn, roster, sessionId })
      if (row !== null) rows.push(row)
      continue
    }

    if (item.type === 'assistant/message') {
      const turn = item.data?.turn ?? currentTurn
      if (hidden(turn)) continue
      const content = Array.isArray(item.data?.message?.content) ? item.data.message.content : []
      const { reasoning, activity } = splitReasoning(content)
      const reasoningMs = streamReasoningMs(item.data?.stream)
      const texts = content
        .filter(block => block?.type === 'text' && typeof block.text === 'string')
        .map(block => stripToolCallTags(block.text))
        .filter(text => text.trim() !== '')
      if (reasoning !== '' || activity.length > 0 || texts.length > 0) {
        rows.push({
          kind: 'assistant',
          key: `assistant:${item.seq}`,
          seq: item.seq,
          time: item.time,
          turn,
          step: item.data?.step,
          reasoning,
          reasoningMs,
          activity,
          texts,
          streaming: false,
          thinkingLive: false,
        })
      }
      continue
    }

    if (item.type === 'tool/call' || item.type === 'tool/ptc-dispatch-start') {
      const turn = item.data?.turn ?? currentTurn
      if (hidden(turn)) continue
      const callId = item.data?.callId ?? `call-${item.seq}`
      const name = typeof item.data?.name === 'string' ? item.data.name : ''
      const argsRaw = typeof item.data?.arguments === 'string'
        ? item.data.arguments
        : (item.data?.arguments === undefined ? '' : JSON.stringify(item.data.arguments))
      const parentCallId = item.data?.parentCallId
      const block = {
        phase: 'start',
        seq: item.seq,
        time: item.time,
        callId,
        ...(parentCallId ? { parentCallId } : {}),
        name,
        argsRaw,
        args: makeToolArgs(argsRaw),
        subCalls: [],
      }
      const entry = {
        kind: 'tool',
        key: `call:${callId}`,
        seq: item.seq,
        time: item.time,
        turn,
        step: item.data?.step,
        callId,
        toolName: name,
        phase: 'start',
        block,
      }
      callsById.set(callId, entry)
      if (parentCallId && callsById.has(parentCallId)) {
        callsById.get(parentCallId).block.subCalls.push(entry)
      } else {
        rows.push(entry)
      }
      continue
    }

    if (item.type === 'tool/result' || item.type === 'tool/ptc-dispatch-end') {
      const turn = item.data?.turn ?? currentTurn
      if (hidden(turn)) continue
      const message = item.data?.message ?? item.data ?? {}
      const callId = message.toolCallId ?? item.data?.callId ?? `result-${item.seq}`
      const content = Array.isArray(message.content) ? message.content : []
      const isError = message.isError === true
      const error = message.error ?? item.data?.error
      const existing = callsById.get(callId)
      if (existing !== undefined) {
        existing.phase = 'result'
        existing.block = {
          kind: 'tool-result',
          seq: item.seq,
          time: item.time,
          callId,
          ...(existing.block.parentCallId ? { parentCallId: existing.block.parentCallId } : {}),
          name: existing.block.name,
          args: existing.block.args,
          call: { name: existing.block.name, argsRaw: existing.block.argsRaw },
          callTime: existing.block.time ?? null,
          content,
          isError,
          ...(error ? { error } : {}),
          subCalls: existing.block.subCalls,
        }
      } else {
        // The paired tool/call fell before the loaded window: still show the settled result
        // under its callId (matching DSH's ToolResultNode contract).
        const block = {
          kind: 'tool-result',
          seq: item.seq,
          time: item.time,
          callId,
          name: '',
          args: makeToolArgs(''),
          call: null,
          callTime: null,
          content,
          isError,
          ...(error ? { error } : {}),
          subCalls: [],
        }
        const entry = {
          kind: 'tool',
          key: `call:${callId}`,
          seq: item.seq,
          time: item.time,
          turn,
          step: item.data?.step,
          callId,
          toolName: '',
          phase: 'result',
          block,
        }
        callsById.set(callId, entry)
        rows.push(entry)
      }
    }
  }

  // Live in-progress reply from DSH's BlockAssembler. `writingBlocks` returns [] once the
  // committed assistant/message for that (turn, step) has landed, so nothing duplicates.
  const writing = writingBlocks(log)
  const writingTurn = log.writing?.turn
  if (writing.length > 0 && !hidden(writingTurn)) {
    const attemptId = log.writing?.attemptId ?? 'live'
    const { reasoning, activity } = splitReasoning(writing)
    const texts = writing
      .filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => stripToolCallTags(block.text))
      .filter(text => text.trim() !== '')
    if (reasoning !== '' || activity.length > 0 || texts.length > 0) {
      rows.push({
        kind: 'assistant',
        key: `writing:${attemptId}`,
        seq: null,
        time: null,
        turn: writingTurn,
        step: log.writing?.step,
        attemptId,
        reasoning,
        reasoningMs: undefined,
        activity,
        texts,
        streaming: true,
        thinkingLive: reasoning !== '' && texts.length === 0,
      })
    }
    let toolIdx = 0
    for (const block of writing) {
      if (block?.type !== 'tool-call') continue
      const callId = block.id || `writing-${attemptId}-${toolIdx}`
      toolIdx += 1
      if (callsById.has(callId)) continue
      const name = typeof block.name === 'string' ? block.name : ''
      const argsRaw = typeof block.arguments === 'string'
        ? block.arguments
        : (block.arguments === undefined ? '' : JSON.stringify(block.arguments))
      rows.push({
        kind: 'tool',
        key: `call:${callId}`,
        seq: null,
        time: null,
        turn: writingTurn,
        step: log.writing?.step,
        callId,
        toolName: name,
        phase: 'preparing',
        block: {
          phase: 'preparing',
          callId,
          name,
          argsRaw,
          args: makeToolArgs(argsRaw),
          subCalls: [],
        },
      })
    }
  }

  return rows
}
