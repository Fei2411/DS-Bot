// A Session's log as a window holds it, built from what `api/bot/session` streams
// (host/session-follow.js: DSH's follow frames as they are) and the earlier pages
// `session-page` reads. The cursor is DSH's: an event's `seq`, the next one is the cursor
// plus one. An event that does not follow on, or a reply chunk out of order, means the
// window missed something: `reopen` says so, and the window opens the follow again; the
// new opening joins on to what it holds, without repeats.
//
// The reply being written is put together with DSH's own assembler
// (`@deepseek-ai/dsh-llm/assistant-stream`), from the opening's compact stream and each
// chunk after it; it goes once the attempt ends, when its committed event has come in
// order (or comes with the next opening).
import { assembleAssistantStream } from '@deepseek-ai/dsh-llm/assistant-stream'

/** @returns {SessionLog} a log that holds nothing yet */
export const emptyLog = () => ({ header: null, cursor: -1, events: [], hasMore: false, projections: null, writing: null, revision: 0 })

const seqOf = event => event.seq
const changed = (log, change) => ({ ...log, ...change, revision: log.revision + 1 })

// Events the window holds and the opening's window, as one ordered list without repeats.
// What the window held before joins on only when nothing lies between the two.
function join(held, opening) {
  if (opening.length === 0) return { events: held, joined: true }
  const first = seqOf(opening[0])
  const before = held.filter(event => seqOf(event) < first)
  if (before.length > 0 && seqOf(before.at(-1)) !== first - 1) return { events: opening, joined: false }
  return { events: [...before, ...opening], joined: before.length > 0 }
}

function writingOf(baseline) {
  const attempt = baseline?.activeAttempt
  if (attempt === undefined) return null
  return { attemptId: attempt.attemptId, turn: attempt.turn, step: attempt.step, startedAfterSeq: attempt.startedAfterSeq, next: attempt.nextIndex, assembler: assembleAssistantStream(attempt.stream) }
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
    const { events, joined } = join(log.events, opening)
    return { log: changed(log, { header: frame.header, cursor: frame.cursor, events, hasMore: joined ? log.hasMore : frame.hasMore, projections: frame.projections ?? null, writing: writingOf(frame.assistantStream) }), reopen: false }
  }
  if (frame?.type === 'event') {
    const seq = seqOf(frame.event)
    if (seq <= log.cursor) return { log, reopen: false }
    if (log.header === null || seq !== log.cursor + 1) return { log, reopen: true }
    return { log: changed(log, { cursor: seq, events: [...log.events, frame.event] }), reopen: false }
  }
  if (frame?.type === 'assistant-stream') {
    const part = frame.frame
    if (part.type === 'start') {
      return { log: changed(log, { writing: { attemptId: part.attemptId, turn: part.turn, step: part.step, startedAfterSeq: part.startedAfterSeq, next: 0, assembler: assembleAssistantStream([]) } }), reopen: false }
    }
    const writing = log.writing
    if (writing === null || writing.attemptId !== part.attemptId) return { log, reopen: part.type === 'chunk' }
    if (part.type === 'chunk') {
      if (part.index < writing.next) return { log, reopen: false }
      if (part.index !== writing.next) return { log, reopen: true }
      writing.assembler.push(part.chunk)
      return { log: changed(log, { writing: { ...writing, next: writing.next + 1 } }), reopen: false }
    }
    if (part.type === 'end') return { log: changed(log, { writing: null }), reopen: false }
  }
  return { log, reopen: false }
}

/**
 * Put an earlier page (`session-page` with `beforeSeq`) in front of what the window holds.
 * @param {SessionLog} log
 * @param {{ records: { event: object }[], hasMore: boolean }} page
 */
export function addPage(log, page) {
  const first = log.events.length > 0 ? seqOf(log.events[0]) : Infinity
  const older = page.records.map(record => record.event).filter(event => seqOf(event) < first)
  if (older.length === 0) return changed(log, { hasMore: page.hasMore })
  return changed(log, { events: [...older, ...log.events], hasMore: page.hasMore })
}

/** @returns {number | undefined} the `beforeSeq` that reads the page before what the window holds */
export const pageBefore = log => (log.hasMore && log.events.length > 0 ? seqOf(log.events[0]) : undefined)

/** @returns {object[]} the blocks of the reply being written: text, reasoning, tool calls */
export const writingBlocks = log => (log.writing === null ? [] : log.writing.assembler.blocks())

/**
 * The conversation's surface: the events that carry it (`surfaceOp`), in their order, with
 * a later event that replaces earlier ones (a summary that stands for them) in their place.
 * @param {SessionLog} log
 * @returns {object[]}
 */
export function surfaceEvents(log) {
  const surface = []
  for (const event of log.events) {
    const op = event.surfaceOp
    if (op === undefined) continue
    if (op === 'append') {
      surface.push(event)
      continue
    }
    if (op?.op === 'replace') {
      const covered = index => seqOf(surface[index]) >= op.startSeq && seqOf(surface[index]) <= op.endSeq
      const at = surface.findIndex((_, index) => covered(index))
      const kept = surface.filter((_, index) => !covered(index))
      kept.splice(at < 0 ? kept.length : at, 0, event)
      surface.splice(0, surface.length, ...kept)
    }
  }
  return surface
}

/**
 * @typedef {{ header: object | null, cursor: number, events: object[], hasMore: boolean, projections: object | null,
 *   writing: { attemptId: string, turn: number, step: number, startedAfterSeq: number, next: number, assembler: object } | null,
 *   revision: number }} SessionLog
 */
