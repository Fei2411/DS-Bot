import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { AssistantStreamAccumulator } from '@deepseek-ai/dsh-llm/assistant-stream'
import { compactCheckpointSource } from '@deepseek-ai/dsh-compaction/checkpoint'
import { addPage, applyFrame, emptyLog, pageBefore, transcriptOf, writingBlocks } from '../src/client/session-log.js'

// What DSH 0.2.2-rc.1 streamed through api/bot/session (dev/record-follow.mjs).
const RECORDED = JSON.parse(readFileSync(new URL('./fixtures/recorded/dsh-follow-0.2.2-rc.1.json', import.meta.url), 'utf8'))
const LIVE = RECORDED.live.map(({ data }) => data)
const REOPENED = RECORDED.reconnect[0].data

function run(frames, log = emptyLog()) {
  const reopened = []
  for (const frame of frames) {
    const next = applyFrame(log, frame)
    if (next.reopen) reopened.push(frame)
    log = next.log
  }
  return { log, reopened }
}
const seqs = log => log.events.map(event => event.seq)
const consecutive = list => list.every((seq, index) => index === 0 || seq === list[index - 1] + 1)

test('the recorded follow builds the whole log, in order, with nothing to reopen', () => {
  const { log, reopened } = run(LIVE)
  assert.deepEqual(reopened, [])
  assert.equal(log.cursor, seqs(log).at(-1))
  assert.ok(consecutive(seqs(log)))
  assert.equal(log.writing, null)
  // The transcript keeps the log's order and every event (nothing in this recording replaces another).
  assert.deepEqual(transcriptOf(log).map(event => event.seq), seqs(log))
})

test('the reply being written reads as DSH assembles it: thinking, text, then a tool call', () => {
  let log = emptyLog()
  const seen = []
  for (const frame of LIVE) {
    log = applyFrame(log, frame).log
    if (frame.type === 'assistant-stream' && frame.frame.type === 'chunk' && frame.frame.chunk.type === 'block-end') seen.push(writingBlocks(log).map(block => block.type).join('+'))
  }
  assert.deepEqual(seen, ['reasoning', 'reasoning+text', 'tool-call', 'text'])
  // While it is written, the blocks are the ones the committed message ends up with; once
  // that message has come, the conversation shows it and not the reply being written too.
  log = emptyLog()
  let checked = 0
  for (const frame of LIVE) {
    if (frame.type === 'event' && frame.event.type === 'assistant/message' && log.writing !== null) {
      assert.deepEqual(writingBlocks(log), frame.event.data.message.content)
      log = applyFrame(log, frame).log
      assert.deepEqual(writingBlocks(log), [])
      checked += 1
      continue
    }
    log = applyFrame(log, frame).log
  }
  assert.equal(checked, 3)
})

test('a log is a value: an older one reads as it did after newer frames', () => {
  let log = emptyLog()
  const kept = []
  for (const frame of LIVE) {
    log = applyFrame(log, frame).log
    if (log.writing !== null) kept.push({ log, blocks: JSON.stringify(writingBlocks(log)) })
  }
  for (const { log: old, blocks } of kept) assert.equal(JSON.stringify(writingBlocks(old)), blocks)
})

test('an opening again joins on to what the window holds, without repeats; the page before joins too', () => {
  const { log: held } = run(LIVE)
  const { log, reopened } = run([REOPENED], held)
  assert.deepEqual(reopened, [])
  assert.deepEqual(seqs(log), seqs(held))
  assert.equal(log.cursor, REOPENED.cursor)
  // A window that opens fresh holds only the newest few; it reads the page before them.
  const { log: fresh } = run([REOPENED])
  assert.equal(pageBefore(fresh), REOPENED.records[0].event.seq)
  const paged = addPage(fresh, RECORDED.page)
  assert.ok(consecutive(seqs(paged)))
  assert.equal(seqs(paged)[0], RECORDED.page.records[0].event.seq)
  // The same page again adds nothing, and neither does a page that does not end right
  // before what is held (the window opened again while it was read).
  assert.equal(addPage(paged, RECORDED.page), paged)
  assert.equal(addPage(fresh, { records: RECORDED.page.records.slice(0, -1), hasMore: false }), fresh)
  // Another Session's opening replaces what the window held, whatever its seqs.
  const other = run([{ ...REOPENED, header: { ...REOPENED.header, id: 'session-other' } }], held).log
  assert.deepEqual(seqs(other), REOPENED.records.map(record => record.event.seq))
})

test('an event missed or a chunk out of order asks to open again; a repeat is dropped', () => {
  const events = LIVE.filter(frame => frame.type === 'event')
  const at = LIVE.indexOf(events[3])
  const { reopened } = run([...LIVE.slice(0, at), ...LIVE.slice(at + 1)])
  assert.equal(reopened[0], LIVE[at + 1])
  const twice = run([...LIVE.slice(0, at + 1), LIVE[at], ...LIVE.slice(at + 1)])
  assert.deepEqual(twice.reopened, [])
  assert.deepEqual(seqs(twice.log), seqs(run(LIVE).log))
  // A chunk skipped.
  const chunk = LIVE.findIndex(frame => frame.type === 'assistant-stream' && frame.frame.type === 'chunk' && frame.frame.index === 1)
  assert.equal(run([...LIVE.slice(0, chunk), ...LIVE.slice(chunk + 1)]).reopened[0], LIVE[chunk + 1])
  // Before any opening, an event cannot be placed.
  assert.equal(applyFrame(emptyLog(), events[0]).reopen, true)
  // A reply frame skipped as a whole (its revision), and a reply that ends with fewer chunks
  // than its end names.
  const stream = LIVE.filter(frame => frame.type === 'assistant-stream')
  const gone = LIVE.indexOf(stream[1])
  const skipped = run([...LIVE.slice(0, gone), ...LIVE.slice(gone + 1)])
  assert.equal(skipped.reopened[0], stream[2])
  const end = LIVE.indexOf(stream.find(frame => frame.frame.type === 'end'))
  const short = { ...LIVE[end], frame: { ...LIVE[end].frame, index: LIVE[end].frame.index + 1 } }
  assert.equal(run([...LIVE.slice(0, end), short]).reopened[0], short)
})

test('an opening in the middle of a reply carries on from DSH\'s compact stream', () => {
  // Cut the recording after the first chunks of the thinking turn and open there: the
  // opening carries what was written so far, compacted by DSH's own accumulator.
  const compact = (frames) => {
    const accumulator = new AssistantStreamAccumulator()
    for (const frame of frames) accumulator.push({ time: frame.frame.time, chunk: frame.frame.chunk })
    return accumulator.snapshot()
  }
  const start = LIVE.findIndex(frame => frame.type === 'assistant-stream' && frame.frame.type === 'start')
  const chunks = LIVE.slice(start + 1).filter(frame => frame.type === 'assistant-stream' && frame.frame.type === 'chunk')
  const opening = {
    ...LIVE[0],
    assistantStream: {
      revision: 3,
      activeAttempt: {
        ...LIVE[start].frame,
        nextIndex: 2,
        stream: compact(chunks.slice(0, 2)),
      },
    },
  }
  let { log } = run([opening])
  assert.deepEqual(writingBlocks(log), [{ type: 'reasoning', text: chunks[1].frame.chunk.text }])
  // The next chunk is index 2; one already in the opening is skipped.
  log = applyFrame(log, chunks[1]).log
  for (const frame of chunks.slice(2, 6)) log = applyFrame(log, frame).log
  assert.deepEqual(writingBlocks(log).map(block => block.type), ['reasoning', 'text'])
})

// Events as DSH writes them when it trims a tool result and when it compacts: a
// replacement user message (the checkpoint, its source from dsh-compaction) and the
// log-only compaction/summary with the same id.
const appended = seq => ({ seq, time: seq, type: seq % 2 ? 'user/message' : 'assistant/message', surfaceOp: 'append', data: {} })
const replaced = (seq, startSeq, endSeq, data = {}) => ({ seq, time: seq, type: 'user/message', surfaceOp: { op: 'replace', startSeq, endSeq }, data })
const held = events => ({ ...emptyLog(), header: { id: 's' }, cursor: events.at(-1).seq, events })

test('the transcript keeps what the user saw: a trimmed result stays, a summary shows as a marker where it was made', () => {
  const events = [1, 2, 3, 4, 5, 6, 7, 8].map(appended)
  const trimmed = { ...replaced(30, 5, 5), type: 'tool/result' }
  const summary = { seq: 39, time: 39, type: 'compaction/summary', data: { compactionId: 'c1', summary: [{ type: 'text', text: 'What happened so far.' }], shadowedSeqs: [2, 3, 4, 30], shadowedTokenCount: 1200 } }
  const checkpoint = replaced(40, 2, 30, { source: compactCheckpointSource('c1'), content: [{ type: 'text', text: 'What happened so far.' }] })
  const shown = transcriptOf(held([...events, trimmed, summary, checkpoint]))
  assert.deepEqual(shown.map(item => item.seq), [1, 2, 3, 4, 5, 6, 7, 8, 40])
  assert.deepEqual(shown.at(-1), { kind: 'compaction', seq: 40, time: 40, compactionId: 'c1', summary: 'What happened so far.', shadowedItemCount: 4, shadowedTokenCount: 1200 })
  // A window that holds only the newest part of a long Session still shows all it holds;
  // a checkpoint whose summary is not in the window yet is a marker without one.
  const late = transcriptOf(held([...[50, 51, 52].map(appended), replaced(53, 12, 12), replaced(54, 20, 52, { source: compactCheckpointSource('c2') }), appended(55)]))
  assert.deepEqual(late.map(item => item.seq), [50, 51, 52, 54, 55])
  assert.equal(late[3].summary, null)
})

test('stream frames never clone the events array, and only events clones do', () => {
  let log = emptyLog()
  const streamClones = []
  const otherClones = []
  for (const frame of LIVE) {
    const before = log
    const next = applyFrame(log, frame)
    log = next.log
    if (log === before || log.events === before.events) continue
    if (frame.type === 'assistant-stream') streamClones.push(frame)
    else otherClones.push(frame)
  }
  assert.deepEqual(streamClones, [], 'no stream frame ever replaces the events array')
  assert.ok(otherClones.length > 0, 'event and snapshot frames do replace it')
})

test('a reply frame counted from 1 again (the Agent started again on this Session) asks to open again', () => {
  const { log } = run(LIVE)
  const start = LIVE.find(frame => frame.type === 'assistant-stream' && frame.frame.type === 'start')
  const again = { ...start, frame: { ...start.frame, attemptId: 'session-main:1', revision: 1 } }
  assert.equal(applyFrame(log, again).reopen, true)
  // A frame of an attempt the window does not hold is left out, not a reason to open again.
  const stray = LIVE.find(frame => frame.type === 'assistant-stream' && frame.frame.type === 'chunk')
  const next = { ...stray, frame: { ...stray.frame, attemptId: 'elsewhere', revision: log.streamRevision + 1 } }
  assert.equal(applyFrame(log, next).reopen, false)
})
