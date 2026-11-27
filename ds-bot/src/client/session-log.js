// A Session's log as a window holds it, built from what `api/bot/session` streams
// (host/session-follow.js: DSH's follow frames as they are) and the earlier pages
// `session-page` reads. The cursor is DSH's: an event's `seq`, the next one is the cursor
// plus one. An event that does not follow on, a reply frame out of order, or a reply that
// ended short means the window missed something: `reopen` says so, and the window opens
// the follow again; the new opening joins on to what it holds, without repeats.
//
// The reply being written is put together with DSH's own assembler
// (`@deepseek-ai/dsh-llm/assistant-stream`), from the opening's compact stream and each
// chunk after it. A log is a value: applying a frame returns a new one and leaves the old
// one reading as it did.
import { assembleAssistantStream } from '@deepseek-ai/dsh-llm/assistant-stream'

/** @returns {SessionLog} a log that holds nothing yet */
export const emptyLog = () => ({ header: null, cursor: -1, events: [], hasMore: false, projections: null, writing: null, streamRevision: null, revision: 0 })

const seqOf = event => event.seq
const changed = (log, change) => ({ ...log, ...change, revision: log.revision + 1 })
const same = { reopen: false }

// A stream frame never clones the events array: only event frames, snapshots and pages
// build a new one. Anything downstream that keys its work on the events array (the
// committed-row cache in the desktop window's transcript) therefore settles a whole
// stream chunk in O(1), without any further signal from here.

// Events the window holds and an opening's window of the same Session, as one ordered list
// without repeats. What the window held joins on only when nothing lies between the two.
function join(log, header, opening) {
  if (log.header?.id !== header?.id) return { events: opening, joined: false }
  if (opening.length === 0) return { events: log.events, joined: true }
  const first = seqOf(opening[0])
  const before = log.events.filter(event => seqOf(event) < first)
  if (before.length > 0 && seqOf(before.at(-1)) !== first - 1) return { events: opening, joined: false }
  return { events: [...before, ...opening], joined: before.length > 0 }
}

// The reply being written. Its chunks are a list that only grows at its end, each node
// pointing at the one before, so every log keeps the chunks it saw; the assembler is
// shared by the logs of one attempt and fed forward when a newer log reads it.
function newWriting({ attemptId, turn, step, startedAfterSeq }, next, stream = []) {
  return { attemptId, turn, step, startedAfterSeq, next, base: stream, tail: null, count: 0, shared: { tail: null, count: 0, assembler: assembleAssistantStream(stream) } }
}

/**
 * Apply one follow frame.
 * @param {SessionLog} log
 * @param {object} frame - a `frame` event's data from `api/bot/session`
 * @returns {{ log: SessionLog, reopen: boolean }}
 */
export function applyFrame(log, frame) {
  if (frame?.type === 'snapshot') {
    const opening = frame.records.map(record => record.event)
    const { events, joined } = join(log, frame.header, opening)
    const attempt = frame.assistantStream?.activeAttempt
    return {
      log: changed(log, {
        header: frame.header,
        cursor: frame.cursor,
        events,
        hasMore: joined ? log.hasMore : frame.hasMore,
        projections: frame.projections ?? null,
        writing: attempt === undefined ? null : newWriting(attempt, attempt.nextIndex, attempt.stream),
        streamRevision: frame.assistantStream?.revision ?? null,
      }),
      reopen: false,
    }
  }
  if (frame?.type === 'event') {
    const seq = seqOf(frame.event)
    if (seq <= log.cursor) return { log, ...same }
    if (log.header === null || seq !== log.cursor + 1) return { log, reopen: true }
    return { log: changed(log, { cursor: seq, events: [...log.events, frame.event] }), reopen: false }
  }
  if (frame?.type === 'assistant-stream') {
    const part = frame.frame
    // Reply frames are numbered on their own, by the Agent's life: each is the one before plus
    // one. Any other number (a frame missed, or an Agent started again on this Session and
    // counting from 1) means the window opens again for a new baseline, as DSH's client does.
    if (log.header === null) return { log, reopen: true }
    if (log.streamRevision !== null && part.revision !== log.streamRevision + 1) return { log, reopen: true }
    const counted = { streamRevision: part.revision }
    if (part.type === 'start') return { log: changed(log, { ...counted, writing: newWriting(part, 0) }), reopen: false }
    const writing = log.writing
    // A frame of an attempt the window does not hold (it began before the opening's cut) is
    // left out, as DSH's client leaves it.
    if (writing === null || writing.attemptId !== part.attemptId) return { log: changed(log, counted), reopen: false }
    if (part.type === 'chunk') {
      if (part.index !== writing.next) return { log, reopen: true }
      const tail = { chunk: part.chunk, before: writing.tail }
      return { log: changed(log, { ...counted, writing: { ...writing, next: writing.next + 1, tail, count: writing.count + 1 } }), reopen: false }
    }
    if (part.type === 'end') {
      // An end that names more chunks than came: the reply's last chunks were missed.
      if (part.index !== writing.next) return { log: changed(log, { ...counted, writing: null }), reopen: true }
      return { log: changed(log, { ...counted, writing: null }), reopen: false }
    }
  }
  return { log, ...same }
}

/**
 * Put an earlier page (`session-page` with `beforeSeq` = `pageBefore(log)`) in front of what
 * the window holds. A page that does not end right before it (the window opened again
 * meanwhile) is left out; the window asks for the page before it again.
 * @param {SessionLog} log
 * @param {{ records: { event: object }[], hasMore: boolean }} page
 * @returns {SessionLog}
 */
export function addPage(log, page) {
  const first = log.events.length > 0 ? seqOf(log.events[0]) : undefined
  const events = page.records.map(record => record.event)
  if (first === undefined || events.length === 0 || seqOf(events.at(-1)) !== first - 1) return log
  return changed(log, { events: [...events, ...log.events], hasMore: page.hasMore })
}

/** @returns {number | undefined} the `beforeSeq` that reads the page before what the window holds */
export const pageBefore = log => (log.hasMore && log.events.length > 0 ? seqOf(log.events[0]) : undefined)

// The committed form of the reply being written has come in order: the conversation shows
// that one, not both.
// Events are ordered by seq. The commit that settles a stream can only sit after its
// start, so read that short tail backwards instead of scanning the whole Session per chunk.
const settled = (log, writing) => {
  for (let at = log.events.length - 1; at >= 0; at -= 1) {
    const event = log.events[at]
    if (seqOf(event) <= writing.startedAfterSeq) break
    if ((event.type === 'assistant/message' || event.type === 'assistant/attempt')
      && event.data?.turn === writing.turn && event.data?.step === writing.step) return true
  }
  return false
}

/** @returns {object[]} the blocks of the reply being written: text, reasoning, tool calls */
export function writingBlocks(log) {
  const writing = log.writing
  if (writing === null || settled(log, writing)) return []
  const { shared } = writing
  // Chunks since the assembler was last fed, if this log is ahead of it on the same list.
  const ahead = []
  let node = writing.tail
  for (let count = writing.count; count > shared.count && node !== null; count -= 1, node = node.before) ahead.push(node.chunk)
  if (node === shared.tail) {
    for (const chunk of ahead.reverse()) shared.assembler.push(chunk)
    shared.tail = writing.tail
    shared.count = writing.count
    return shared.assembler.blocks()
  }
  // An older log, or another branch: its own chunks from the start.
  const own = []
  for (let at = writing.tail; at !== null; at = at.before) own.push(at.chunk)
  const assembler = assembleAssistantStream(writing.base)
  for (const chunk of own.reverse()) assembler.push(chunk)
  return assembler.blocks()
}

// A summary that stands for earlier messages: its checkpoint (a replacement user message
// whose source is `compact-checkpoint`) and the `compaction/summary` with the same id.
const checkpointOf = event => (event.type === 'user/message' && event.surfaceOp !== undefined && event.surfaceOp !== 'append' && event.data?.source?.kind === 'compact-checkpoint' ? event.data.source.compactionId : undefined)
const textOf = blocks => (Array.isArray(blocks) ? blocks.map(block => (block?.type === 'text' ? block.text : '')).join('') : '')

/**
 * The conversation as a person reads it, as DSH's own chat builds it: the events in log
 * order, each conversation event as it was first written (`surfaceOp: 'append'`). What
 * stands in for earlier events in the model's history (a trimmed tool result, a summary)
 * does not take their place here, so nothing the user already saw goes; a summary shows
 * as a marker where it was made. Events outside the conversation (turns, steps, tool
 * calls) come along in their order for the views that place things by them.
 * @param {SessionLog} log
 * @returns {object[]} events, and `{ kind: 'compaction', seq, time, compactionId, summary, shadowedItemCount, shadowedTokenCount }` markers
 */
export function transcriptOf(log) {
  const summaries = new Map()
  for (const event of log.events) {
    if (event.type === 'compaction/summary' && typeof event.data?.compactionId === 'string') summaries.set(event.data.compactionId, event.data)
  }
  const out = []
  for (const event of log.events) {
    const compactionId = checkpointOf(event)
    if (compactionId !== undefined) {
      const data = summaries.get(compactionId)
      const counted = Array.isArray(data?.shadowedSeqs) ? data.shadowedSeqs.length : null
      out.push({
        kind: 'compaction', seq: event.seq, time: event.time, compactionId,
        summary: data === undefined ? null : (textOf(data.summary).trim() || null),
        shadowedItemCount: counted,
        shadowedTokenCount: Number.isSafeInteger(data?.shadowedTokenCount) ? data.shadowedTokenCount : null,
      })
      continue
    }
    if (event.type === 'compaction/summary') continue
    if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') continue
    out.push(event)
  }
  return out
}

/**
 * @typedef {{ header: object | null, cursor: number, events: object[], hasMore: boolean, projections: object | null,
 *   writing: object | null, streamRevision: number | null, revision: number }} SessionLog
 */
