import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { AssistantStreamAccumulator } from '@deepseek-ai/dsh-llm/assistant-stream'
import { addPage, applyFrame, emptyLog, pageBefore, surfaceOf, writingBlocks } from '../src/client/session-log.js'

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
  const { events: shown, uncertain } = surfaceOf(log)
  assert.equal(uncertain, false)
  const surface = shown.map(event => event.type)
  assert.ok(surface.includes('user/message') && surface.includes('assistant/message') && surface.includes('tool/result'))
  assert.ok(!surface.includes('turn/start') && !surface.includes('request/header'))
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

// The surface operations as DSH writes them (SessionWireSurfaceOp): a trimmed tool result
// and a summary replace a range of earlier surface events, found by their positions.
const surface = list => ({ ...emptyLog(), header: { id: 's' }, events: list.map(([seq, op]) => ({ seq, type: 'x', surfaceOp: op ?? 'append' })) })
const order = log => surfaceOf(log).events.map(event => event.seq)

test('a replacement stands where the first event it replaces stood, and removes up to the last', () => {
  const appended = [1, 2, 3, 4, 5, 6, 7, 8].map(seq => [seq])
  // A tool result trimmed (5 by 30), then a summary of 2 to that trimmed result.
  assert.deepEqual(order(surface([...appended, [30, { op: 'replace', startSeq: 5, endSeq: 5 }], [40, { op: 'replace', startSeq: 2, endSeq: 30 }]])), [1, 40, 6, 7, 8])
  // Two summaries: the second starts at the first one.
  assert.deepEqual(order(surface([...appended, [10, { op: 'replace', startSeq: 2, endSeq: 4 }], [20, { op: 'replace', startSeq: 10, endSeq: 7 }]])), [1, 20, 8])
  // A replacement that names an event before the window: not known until the page before.
  const cut = surface([[6], [7], [8], [20, { op: 'replace', startSeq: 2, endSeq: 7 }]])
  assert.deepEqual(surfaceOf(cut), { events: [], uncertain: true })
})
