// Projects a SessionLog (ds-bot/src/client/session-log.js) into ordered display rows
// for a Bot's own chat (current segment): user messages, settled card replies, assistant
// replies with thinking and local-agent activity, paired native & PTC tool calls
// (preparing -> start -> result, keeping DSH's ToolCallBlock & PartialArguments contracts),
// compaction checkpoints, Bot/schedule events, and failed turns.
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { transcriptOf, writingBlocks } from '../../../ds-bot/src/client/session-log.js'
import { contentText, isHiddenTurn, reminderPrompts, stripToolCallTags } from '../../../ds-bot/src/client/text.js'
import { contentParts, viaOf } from '../../../ds-bot/src/client/user-message.js'

const ACTIVITY_PREFIX = '▸ '
const HIDDEN_BOT_ROLES = new Set(['kickoff', 'room', 'goal', 'task-handoff', 'handback', 'secret'])
const INTERRUPTED_ERROR = Object.freeze({ name: 'Interrupted', code: 'interrupted' })

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

function stringifyArgs(raw) {
  if (typeof raw === 'string') return raw
  if (raw === undefined || raw === null) return ''
  try { return JSON.stringify(raw) } catch { return '' }
}

/**
 * Builds a DSH `PartialArguments` view from streamed text, sealed text, or a parsed object.
 * @param {unknown} raw
 * @param {{ sealed?: boolean }} [options]
 * @returns {PartialArguments}
 */
export function makeToolArgs(raw, { sealed = true } = {}) {
  if (raw instanceof PartialArguments) return raw
  if (raw === undefined || raw === null || raw === '') return PartialArguments.EMPTY
  if (typeof raw === 'string') {
    if (sealed) return PartialArguments.fromText(raw)
    const view = new PartialArguments()
    view.append(raw)
    return view
  }
  return PartialArguments.fromObject(raw)
}

function parseQuestionReply(rawText) {
  let parsed = null
  try { parsed = JSON.parse(rawText) } catch { return null }
  if (!parsed || typeof parsed !== 'object') return null
  if (parsed.kind === 'answer_to_pending_handoff' && typeof parsed.reason === 'string') {
    return { text: rawText }
  }
  if (parsed.kind === 'answer_to_pending_view' && Array.isArray(parsed.views) && parsed.views.length > 0) {
    return { text: rawText, views: parsed.views, answers: Array.isArray(parsed.answers) ? parsed.answers : [] }
  }
  const questions = Array.isArray(parsed.questions)
    ? parsed.questions.filter(item => typeof item?.id === 'string' && typeof item.question === 'string')
    : []
  if (questions.length > 0) {
    const answers = (Array.isArray(parsed.answers) ? parsed.answers : [])
      .filter(item => typeof item?.id === 'string' && Array.isArray(item.selected))
    return { text: rawText, questions, answers }
  }
  return null
}

function classifyUserMessage(event, { turn, roster, sessionId }) {
  const data = event.data ?? {}
  const source = data.source !== null && typeof data.source === 'object' ? data.source : {}
  const content = Array.isArray(data.content) ? data.content : []
  if (source.kind === 'user') {
    const { text, attachments, rest } = contentParts(content)
    const apiName = roster?.apiVia?.[sessionId]?.[event.seq]
    const via = (apiName ? `api:${apiName}` : undefined) ?? viaOf(source, roster) ?? roster?.imVia?.[sessionId]?.[event.seq]
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
  if (source.kind === 'user-question-reply') {
    const raw = contentText(content)
    const replyData = raw ? parseQuestionReply(raw) : null
    if (!replyData) return null
    return {
      kind: 'answer',
      key: `answer:${event.seq}`,
      seq: event.seq,
      time: event.time,
      turn,
      data: replyData,
    }
  }
  if (source.kind === 'bot') {
    if (source.handoff === true) return { kind: 'part-start', key: `part:${event.seq}`, seq: event.seq, time: event.time, turn }
    if (HIDDEN_BOT_ROLES.has(source.role) || source.deferred === true) return null
    if (source.role === 'update') return { kind: 'event', key: `ev:${event.seq}`, seq: event.seq, time: event.time, turn, eventKind: 'update' }
    if (source.role === 'resume' || source.resumed === true) return { kind: 'event', key: `ev:${event.seq}`, seq: event.seq, time: event.time, turn, eventKind: 'resume' }
    if (source.role === 'retry' || source.retried === true) return { kind: 'event', key: `ev:${event.seq}`, seq: event.seq, time: event.time, turn, eventKind: 'retry' }
    if (source.role === 'continue') return { kind: 'event', key: `ev:${event.seq}`, seq: event.seq, time: event.time, turn, eventKind: 'continue' }
    if (source.role === 'report') return { kind: 'event', key: `ev:${event.seq}`, seq: event.seq, time: event.time, turn, eventKind: 'report', roomId: source.roomId }
    if (source.role === 'request' || source.role === 'reply' || source.role === 'stopped') {
      return {
        kind: 'event',
        key: `ev:${event.seq}`,
        seq: event.seq,
        time: event.time,
        turn,
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
      turn,
      eventKind: 'schedule',
      text: prompts.join(' · ').slice(0, 80),
    }
  }
  // System injections (agent-instructions, runtime-context, skill-catalog, time-context,
  // goal) never render as user bubbles.
  return null
}

function turnEndFailure(reason) {
  if (!reason || typeof reason !== 'object') return undefined
  if (reason.kind === 'error') return reason.error ?? {}
  if (reason.kind === 'aborted' && reason.reason?.kind === 'hook' && reason.reason?.reason === 'deepseek-account/signed-out') {
    return { code: 'ACCOUNT_SIGNED_OUT', message: t('Stopped because you signed out of DeepSeek.') }
  }
  if (reason.kind === 'interrupted') {
    return { code: 'INTERRUPTED', message: t('The DSH process exited before this turn finished.') }
  }
  return undefined
}

function toResultBlock(prev, { seq, time, turn, step, content, isError, meta, error }) {
  const name = prev.name ?? ''
  const argsRaw = prev.argsRaw ?? ''
  return {
    kind: 'tool-result',
    phase: 'result',
    seq,
    time,
    turn: turn ?? prev.turn,
    step: step ?? prev.step,
    callId: prev.callId,
    ...(prev.parentCallId ? { parentCallId: prev.parentCallId } : {}),
    ...(prev.rootCallId ? { rootCallId: prev.rootCallId } : {}),
    name,
    argsRaw,
    args: prev.args ?? PartialArguments.EMPTY,
    call: name !== '' || argsRaw !== '' ? { name, argsRaw } : null,
    callTime: prev.time ?? null,
    content,
    isError,
    ...(meta !== undefined ? { meta } : {}),
    ...(error !== undefined ? { error } : {}),
    subCalls: prev.subCalls ?? [],
  }
}

/**
 * Extracts DSH-compatible `{ turns: Map<number, { turn, status, start, end? }>, openTurn }`
 * from `SessionLog.events` for `BtwDock`, `BtwTurnTail`, `LearningDock`, and `LearningTurnTail`.
 * Hidden Bot-exchange turns (which have no visible `turn-tail`) are excluded so proposals
 * never strand on a hidden turn.
 */
export function extractTurnFacts(events, { roster, sessionId } = {}) {
  const turns = new Map()
  const hidden = turn => (roster?.exchangeTurns && sessionId ? isHiddenTurn(roster, sessionId, turn) : false)
  let openTurn
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== 'object') continue
    const turn = event.data?.turn
    if (!Number.isInteger(turn) || hidden(turn)) continue
    const mark = Number.isFinite(event.time) ? { seq: event.seq, time: event.time } : { seq: event.seq }
    if (event.type === 'turn/start') {
      const existing = turns.get(turn)
      turns.set(turn, {
        turn,
        status: existing?.end ? 'closed' : 'open',
        start: existing?.start ?? mark,
        ...(existing?.end ? { end: existing.end } : {}),
      })
      if (!existing?.end) openTurn = turn
    } else if (event.type === 'turn/end') {
      const existing = turns.get(turn)
      turns.set(turn, {
        turn,
        status: 'closed',
        start: existing?.start ?? mark,
        end: mark,
      })
      if (openTurn === turn) openTurn = undefined
    }
  }
  return { turns, openTurn }
}

const hiddenTurn = (roster, sessionId, turn) => (roster?.exchangeTurns && sessionId ? isHiddenTurn(roster, sessionId, turn) : false)

// Committed rows of one events array never change afterwards: a stream chunk only grows
// the reply being written, it never touches the events the window already holds. They
// are cached on the events array itself, and inside it once more on the roster (two
// nested WeakMaps, so a dropped log or roster takes its entries with it): a stream-only
// frame finds its rows in O(1) as the very same objects, and interleaving rosters never
// evict each other. The roster and the session id shape the rows, so a cached entry only
// serves a call whose roster and session id are the ones it was built with.
const committedRowsCache = new WeakMap()
const NO_ROSTER = {}

function committedRowsOf(events, roster, sessionId) {
  let byRoster = committedRowsCache.get(events)
  if (byRoster === undefined) {
    byRoster = new WeakMap()
    committedRowsCache.set(events, byRoster)
  }
  const key = typeof roster === 'object' && roster !== null ? roster : NO_ROSTER
  // One roster almost always means one session here, so the slot holds a short list of
  // entries and a lookup scans it; building never evicts another session id's rows.
  const entries = byRoster.get(key) ?? []
  const cached = entries.find(entry => entry.roster === roster && entry.sessionId === sessionId)
  if (cached !== undefined) return cached
  const entry = buildCommittedRows(events, roster, sessionId)
  entries.push(entry)
  if (entries.length > 4) entries.shift()
  byRoster.set(key, entries)
  return entry
}

function buildCommittedRows(events, roster, sessionId) {
  // transcriptOf reads the events alone; the rest of the log plays no part here.
  const items = transcriptOf({ events })
  const rows = []
  // Maps every callId / subCallId to its handle so upgrades (preparing -> start -> result)
  // and PTC nested dispatches update the exact ToolCallBlock in place without wrapper drift.
  const callsById = new Map()
  const turnStarts = new Map()
  let currentTurn
  let currentStep
  const hidden = turn => hiddenTurn(roster, sessionId, turn)

  const addTopTool = (block, { seq, time, turn, step }) => {
    const row = {
      kind: 'tool',
      key: `call:${block.callId}`,
      seq,
      time,
      turn,
      step,
      callId: block.callId,
      toolName: block.name,
      phase: block.phase,
      block,
    }
    rows.push(row)
    const handle = {
      row,
      block,
      phase: block.phase,
      turn,
      step,
      update(nextBlock) {
        this.block = nextBlock
        this.phase = nextBlock.phase
        row.block = nextBlock
        row.phase = nextBlock.phase
        row.toolName = nextBlock.name
        if (nextBlock.seq !== undefined && row.seq === null) row.seq = nextBlock.seq
        if (Number.isFinite(nextBlock.time) && !Number.isFinite(row.time)) row.time = nextBlock.time
      },
    }
    callsById.set(block.callId, handle)
    return handle
  }

  const addChildTool = (parentHandle, block, { turn, step }) => {
    const list = parentHandle.block.subCalls
    const index = list.length
    list.push(block)
    const handle = {
      row: null,
      parent: parentHandle,
      block,
      phase: block.phase,
      turn,
      step,
      update(nextBlock) {
        this.block = nextBlock
        this.phase = nextBlock.phase
        parentHandle.block.subCalls[index] = nextBlock
      },
    }
    callsById.set(block.callId, handle)
    return handle
  }

  const settleOpenCalls = ({ turn, step, time, dropPreparing }) => {
    const droppedRows = new Set()
    for (const [callId, handle] of callsById) {
      if (turn !== undefined && handle.turn !== turn) continue
      if (step !== undefined && handle.step !== step) continue
      if (handle.phase === 'start') {
        handle.update(toResultBlock(handle.block, {
          seq: handle.block.seq,
          time: time ?? handle.block.time ?? null,
          turn: handle.turn,
          step: handle.step,
          content: [],
          isError: true,
          error: INTERRUPTED_ERROR,
        }))
      } else if (dropPreparing && handle.phase === 'preparing') {
        if (handle.row !== null) droppedRows.add(handle.row)
        callsById.delete(callId)
      }
    }
    if (droppedRows.size > 0) {
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (droppedRows.has(rows[i])) rows.splice(i, 1)
      }
    }
  }

  const closedCards = sessionId ? roster?.closedCards?.[sessionId] : undefined
  // Hidden Bot-to-Bot turns keep their own calls out of the chat, except a question or
  // view card closed into `closedCards` (dismissed, answered by message, or superseded),
  // matching plugin-mode `ToolCell` and earlier-part pagination (#2242).
  const isClosedCard = (name, callId) => (name === 'ask_user' || name === 'show_view')
    && typeof callId === 'string' && callId !== '' && closedCards?.[callId] !== undefined

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
      if (Number.isInteger(item.data?.turn)) {
        currentTurn = item.data.turn
        if (!turnStarts.has(currentTurn)) {
          turnStarts.set(currentTurn, Number.isFinite(item.time) ? { seq: item.seq, time: item.time } : { seq: item.seq })
        }
      }
      currentStep = undefined
      continue
    }

    if (item.type === 'step/start') {
      if (Number.isInteger(item.data?.turn)) currentTurn = item.data.turn
      if (Number.isInteger(item.data?.step)) currentStep = item.data.step
      continue
    }

    if (item.type === 'step/end') {
      const turn = item.data?.turn ?? currentTurn
      const step = item.data?.step ?? currentStep
      settleOpenCalls({ turn, step, time: item.time, dropPreparing: true })
      continue
    }

    if (item.type === 'turn/end') {
      const turn = item.data?.turn ?? currentTurn
      settleOpenCalls({ turn, step: undefined, time: item.time, dropPreparing: true })
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
      if (!hidden(turn) && Number.isInteger(turn)) {
        const endMark = Number.isFinite(item.time) ? { seq: item.seq, time: item.time } : { seq: item.seq }
        rows.push({
          kind: 'turn-tail',
          key: `turn-tail:${turn}`,
          seq: item.seq,
          time: null,
          turn,
          turnInfo: { turn, status: 'closed', start: turnStarts.get(turn) ?? endMark, end: endMark },
        })
      }
      currentTurn = undefined
      currentStep = undefined
      continue
    }

    if (item.type === 'workspace/changes') {
      const turn = item.data?.turn ?? currentTurn
      if (!hidden(turn) && Number.isInteger(item.seq)) {
        rows.push({
          kind: 'changes',
          key: `changes:${item.seq}`,
          seq: item.seq,
          time: item.time,
          turn,
        })
      }
      continue
    }

    if (item.type === 'deliverables/presented') {
      const turn = item.data?.turn ?? currentTurn
      const files = Array.isArray(item.data?.files)
        ? item.data.files
          .map((file, index) => (file && typeof file.path === 'string' && file.path.trim() !== '' ? { ...file, index } : null))
          .filter(Boolean)
        : []
      if (!hidden(turn) && files.length > 0) {
        rows.push({
          kind: 'deliverables',
          key: `deliverables:${item.seq}`,
          seq: item.seq,
          time: item.time,
          turn,
          files,
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
      const step = item.data?.step ?? currentStep
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
          messageId: typeof item.data?.message?.id === 'string' && item.data.message.id !== '' ? item.data.message.id : undefined,
          time: item.time,
          turn,
          step,
          reasoning,
          reasoningMs,
          activity,
          texts,
          streaming: false,
          thinkingLive: false,
        })
      }
      // Keep tool-call blocks committed on assistant/message in `preparing` until `tool/call`
      // arrives so cards never unmount and flicker between assistant/message and tool/call.
      let callIdx = 0
      for (const block of content) {
        if (block?.type !== 'tool-call') continue
        const callId = block.id || `msg-${item.seq}-${callIdx}`
        callIdx += 1
        if (callsById.has(callId)) continue
        const name = typeof block.name === 'string' ? block.name : ''
        const argsRaw = stringifyArgs(block.arguments)
        addTopTool({
          phase: 'preparing',
          seq: item.seq,
          time: item.time,
          turn,
          step,
          callId,
          name,
          argsRaw,
          args: makeToolArgs(block.arguments, { sealed: true }),
          subCalls: [],
        }, { seq: item.seq, time: item.time, turn, step })
      }
      continue
    }

    if (item.type === 'tool/call') {
      const turn = item.data?.turn ?? currentTurn
      const step = item.data?.step ?? currentStep
      const callId = item.data?.callId ?? `call-${item.seq}`
      const name = typeof item.data?.name === 'string' ? item.data.name : ''
      if (hidden(turn) && !isClosedCard(name, callId)) continue
      const argsRaw = stringifyArgs(item.data?.arguments)
      const existing = callsById.get(callId)
      const block = {
        phase: 'start',
        seq: item.seq,
        time: item.time,
        turn,
        step,
        callId,
        name,
        argsRaw,
        args: makeToolArgs(item.data?.arguments, { sealed: true }),
        subCalls: existing?.block?.subCalls ?? [],
      }
      if (existing !== undefined) {
        existing.turn = turn
        existing.step = step
        existing.update(block)
      } else {
        addTopTool(block, { seq: item.seq, time: item.time, turn, step })
      }
      continue
    }

    if (item.type === 'tool/result') {
      const turn = item.data?.turn ?? currentTurn
      const step = item.data?.step ?? currentStep
      const message = item.data?.message ?? item.data ?? {}
      const callId = message.source?.callId ?? message.toolCallId ?? item.data?.callId ?? `result-${item.seq}`
      const existing = callsById.get(callId)
      if (hidden(turn) && existing === undefined) continue
      const content = Array.isArray(message.content) ? message.content : []
      const isError = message.isError === true
      const meta = item.data?.meta
      const error = message.error ?? item.data?.error
      if (existing !== undefined) {
        existing.update(toResultBlock(existing.block, { seq: item.seq, time: item.time, turn, step, content, isError, meta, error }))
      } else {
        // The paired tool/call fell before the loaded window: show the settled result under its
        // callId with call: null (matching DSH's ToolResultNode contract).
        addTopTool({
          kind: 'tool-result',
          phase: 'result',
          seq: item.seq,
          time: item.time,
          turn,
          step,
          callId,
          name: '',
          argsRaw: '',
          args: PartialArguments.EMPTY,
          call: null,
          callTime: null,
          content,
          isError,
          ...(meta !== undefined ? { meta } : {}),
          ...(error !== undefined ? { error } : {}),
          subCalls: [],
        }, { seq: item.seq, time: item.time, turn, step })
      }
      continue
    }

    if (item.type === 'tool/ptc-dispatch-start') {
      const turn = currentTurn
      const step = currentStep
      const data = item.data ?? {}
      const subCallId = data.subCallId ?? `ptc-${item.seq}`
      const parentCallId = data.parentCallId ?? data.rootCallId
      const rootCallId = data.rootCallId
      const name = typeof data.name === 'string' ? data.name : ''
      const argsRaw = stringifyArgs(data.arguments)
      const parentHandle = parentCallId ? callsById.get(parentCallId) : undefined
      const effectiveTurn = parentHandle?.turn ?? turn
      const effectiveStep = parentHandle?.step ?? step
      if (hidden(effectiveTurn) && !isClosedCard(name, subCallId)) continue
      const block = {
        phase: 'start',
        seq: item.seq,
        time: item.time,
        turn: effectiveTurn,
        step: effectiveStep,
        callId: subCallId,
        ...(parentCallId ? { parentCallId } : {}),
        ...(rootCallId ? { rootCallId } : {}),
        name,
        argsRaw,
        args: makeToolArgs(data.arguments, { sealed: true }),
        subCalls: [],
      }
      const existing = callsById.get(subCallId)
      if (existing !== undefined) existing.update(block)
      else if (parentHandle !== undefined) addChildTool(parentHandle, block, { turn: effectiveTurn, step: effectiveStep })
      else addTopTool(block, { seq: item.seq, time: item.time, turn: effectiveTurn, step: effectiveStep })
      continue
    }

    if (item.type === 'tool/ptc-dispatch') {
      const data = item.data ?? {}
      const subCallId = data.subCallId ?? `ptc-result-${item.seq}`
      const parentCallId = data.parentCallId ?? data.rootCallId
      const rootCallId = data.rootCallId
      const parentHandle = parentCallId ? callsById.get(parentCallId) : undefined
      const existing = callsById.get(subCallId)
      const effectiveTurn = existing?.turn ?? parentHandle?.turn ?? currentTurn
      const effectiveStep = existing?.step ?? parentHandle?.step ?? currentStep
      const name = typeof data.name === 'string' ? data.name : (existing?.block?.name ?? '')
      if (hidden(effectiveTurn) && existing === undefined && !isClosedCard(name, subCallId)) continue
      const argsRaw = data.arguments !== undefined ? stringifyArgs(data.arguments) : (existing?.block?.argsRaw ?? '')
      const content = Array.isArray(data.content) ? data.content : []
      const isError = data.isError === true
      const meta = data.meta
      const error = data.error
      if (existing !== undefined) {
        existing.update(toResultBlock(existing.block, {
          seq: item.seq,
          time: item.time,
          turn: effectiveTurn,
          step: effectiveStep,
          content,
          isError,
          meta,
          error,
        }))
      } else {
        // The matching `tool/ptc-dispatch-start` fell before the loaded window: `tool/ptc-dispatch`
        // still carries parentCallId, name, and arguments, so attach cleanly to the parent call.
        const block = {
          kind: 'tool-result',
          phase: 'result',
          seq: item.seq,
          time: item.time,
          turn: effectiveTurn,
          step: effectiveStep,
          callId: subCallId,
          ...(parentCallId ? { parentCallId } : {}),
          ...(rootCallId ? { rootCallId } : {}),
          name,
          argsRaw,
          args: makeToolArgs(data.arguments, { sealed: true }),
          call: name !== '' || argsRaw !== '' ? { name, argsRaw } : null,
          callTime: null,
          content,
          isError,
          ...(meta !== undefined ? { meta } : {}),
          ...(error !== undefined ? { error } : {}),
          subCalls: [],
        }
        if (parentHandle !== undefined) addChildTool(parentHandle, block, { turn: effectiveTurn, step: effectiveStep })
        else addTopTool(block, { seq: item.seq, time: item.time, turn: effectiveTurn, step: effectiveStep })
      }
    }
  }

  return { rows, callsById, roster, sessionId }
}

// Live in-progress reply rows from DSH's BlockAssembler, rebuilt per stream chunk. They
// are the only rows a stream-only frame can change; everything before them comes from
// the memoized committed build. `writingBlocks` returns [] once the committed
// assistant/message for that (turn, step) has landed, so nothing duplicates.
function writingRows(log, committed, roster, sessionId) {
  const rows = []
  const writing = writingBlocks(log)
  const writingTurn = log.writing?.turn
  const writingStep = log.writing?.step
  if (writing.length === 0 || hiddenTurn(roster, sessionId, writingTurn)) return rows
  const taken = new Set()
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
      step: writingStep,
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
    if (taken.has(callId) || committed.callsById.has(callId)) continue
    taken.add(callId)
    const name = typeof block.name === 'string' ? block.name : ''
    const argsRaw = stringifyArgs(block.arguments)
    rows.push({
      kind: 'tool',
      key: `call:${callId}`,
      seq: null,
      time: null,
      turn: writingTurn,
      step: writingStep,
      callId,
      toolName: name,
      phase: 'preparing',
      block: {
        phase: 'preparing',
        turn: writingTurn,
        step: writingStep,
        callId,
        name,
        argsRaw,
        args: makeToolArgs(block.arguments, { sealed: false }),
        subCalls: [],
      },
    })
  }
  return rows
}

/**
 * Converts a SessionLog into ordered display rows for a DM chat.
 * @param {import('../../../ds-bot/src/client/session-log.js').SessionLog} log
 * @param {{ roster?: object, sessionId?: string }} [options]
 * @returns {object[]}
 */
export function buildSessionRowParts(log, { roster, sessionId } = {}) {
  const events = Array.isArray(log?.events) ? log.events : []
  const committed = committedRowsOf(events, roster, sessionId)
  const live = writingRows(log, committed, roster, sessionId)
  return { committed: committed.rows, live }
}

export function buildSessionRows(log, { roster, sessionId } = {}) {
  const { committed, live } = buildSessionRowParts(log, { roster, sessionId })
  return live.length === 0 ? committed : [...committed, ...live]
}
