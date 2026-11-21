import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { AssistantStreamAccumulator } from '@deepseek-ai/dsh-llm/assistant-stream'
import { addPage, applyFrame, emptyLog, pageBefore, surfaceEvents, writingBlocks } from '../src/client/session-log.js'

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
  const surface = surfaceEvents(log).map(event => event.type)
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
  // While it is written, the blocks are the ones the committed message ends up with.
  log = emptyLog()
  for (const frame of LIVE) {
    if (frame.type === 'assistant-stream' && frame.frame.type === 'end') {
      const committed = log.events.find(event => event.seq === frame.frame.outcome.seq) ?? LIVE.find(item => item.type === 'event' && item.event.seq === frame.frame.outcome.seq).event
      assert.deepEqual(writingBlocks(log), committed.data.message.content.filter(block => block.type !== 'finish'))
    }
    log = applyFrame(log, frame).log
  }
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
  // The same page again adds nothing.
  assert.deepEqual(seqs(addPage(paged, RECORDED.page)), seqs(paged))
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
