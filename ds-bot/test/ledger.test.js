import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install, bookFile, parseBook } from '../src/host/ledger.js'
import { relayRange } from '../src/shared/group-replies.js'

const host = (t, { home = mkdtempSync(join(tmpdir(), 'ds-bot-ledger-')), readOnly } = {}) => {
  const warnings = []
  const rt = { home, readOnly: () => readOnly?.(), warn: (...args) => warnings.push(args) }
  install(rt)
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  return { rt, home, warnings, file: book => join(home, 'ledger', bookFile(book)) }
}

test('a record is in memory at once and on disk in order, one line each', async (t) => {
  const { rt, file } = host(t)
  for (let seq = 1; seq <= 50; seq += 1) rt.ledger.append('group-r1', { seq, text: `line ${seq}` })
  assert.equal(rt.ledger.record('group-r1', 50).text, 'line 50')
  await rt.ledger.flush('group-r1')
  assert.deepEqual(parseBook(readFileSync(file('group-r1'), 'utf8')).map(record => record.seq), Array.from({ length: 50 }, (_, at) => at + 1))
})

test('reads by range, after a seq, and by words, newest first', (t) => {
  const { rt } = host(t)
  for (const [seq, text] of [[1, 'plan the launch'], [2, 'launch notes'], [3, 'lunch'], [4, 'Launch day']]) rt.ledger.append('group-r1', { seq, text })
  assert.deepEqual(rt.ledger.range('group-r1', 2, 3).map(record => record.seq), [2, 3])
  assert.deepEqual(rt.ledger.range('group-r1', 3).map(record => record.seq), [3, 4])
  assert.deepEqual(rt.ledger.after('group-r1', 2).map(record => record.seq), [3, 4])
  assert.deepEqual(rt.ledger.search('group-r1', 'launch').map(record => record.seq), [4, 2, 1])
  assert.equal(rt.ledger.lastSeq('group-r1'), 4)
})

test('a line cut by an interruption is left out, and the book goes on after it', async (t) => {
  const { rt, home, file } = host(t)
  mkdirSync(join(home, 'ledger'), { recursive: true })
  writeFileSync(file('group-r1'), `${JSON.stringify({ seq: 1, text: 'whole' })}\n{"seq":2,"text":"cu`)
  assert.deepEqual(rt.ledger.records('group-r1').map(record => record.seq), [1])
  rt.ledger.append('group-r1', { seq: 2, text: 'again' })
  await rt.ledger.flush('group-r1')
  const again = host(t, { home })
  assert.deepEqual(again.rt.ledger.records('group-r1').map(record => record.text), ['whole', 'again'])
})

test('a book that does not exist yet starts from its importer, once, and only a writing host keeps it', async (t) => {
  const { rt, home, file } = host(t)
  let asked = 0
  rt.ledger.importer('group-', () => { asked += 1; return [{ seq: 1, text: 'from before' }] })
  assert.deepEqual(rt.ledger.records('group-r1').map(record => record.text), ['from before'])
  assert.equal(existsSync(file('group-r1')), true)
  const reader = host(t, { home, readOnly: () => 'another dsh holds the team' })
  reader.rt.ledger.importer('group-', () => { asked += 1; return [{ seq: 1, text: 'from before' }] })
  assert.deepEqual(reader.rt.ledger.records('group-r1').map(record => record.text), ['from before'])
  assert.equal(asked, 1)
  const fresh = host(t, { readOnly: () => 'read only' })
  fresh.rt.ledger.importer('group-', () => [{ seq: 1, text: 'old' }])
  assert.equal(fresh.rt.ledger.records('group-r2').length, 1)
  assert.equal(existsSync(fresh.file('group-r2')), false)
})

test('a window that only reads follows the book another host writes', async (t) => {
  const writer = host(t)
  writer.rt.ledger.append('group-r1', { seq: 1, text: 'one' })
  await writer.rt.ledger.flush()
  const reader = host(t, { home: writer.home, readOnly: () => 'read only' })
  assert.equal(reader.rt.ledger.lastSeq('group-r1'), 1)
  writer.rt.ledger.append('group-r1', { seq: 2, text: 'two' })
  await writer.rt.ledger.flush()
  assert.equal(reader.rt.ledger.lastSeq('group-r1'), 2)
  // It writes nothing of its own.
  reader.rt.ledger.append('group-r1', { seq: 3, text: 'not kept' })
  await reader.rt.ledger.flush()
  assert.equal(parseBook(readFileSync(writer.file('group-r1'), 'utf8')).length, 2)
})

test('dropping a book removes its file after the writes before it', async (t) => {
  const { rt, file } = host(t)
  rt.ledger.append('group-r1', { seq: 1, text: 'one' })
  rt.ledger.drop('group-r1')
  await rt.ledger.flush('group-r1')
  assert.equal(existsSync(file('group-r1')), false)
  assert.deepEqual(rt.ledger.records('group-r1'), [])
})

test('a book with an id that is not a plain name gets a file name of its own', () => {
  assert.equal(bookFile('group-r1'), 'group-r1.jsonl')
  assert.match(bookFile('group-../x'), /^[0-9a-f]{32}\.jsonl$/)
  assert.notEqual(bookFile('group-../x'), bookFile('group-../y'))
})

test("a round's result names its rows; a result from before the ledger does not", () => {
  assert.deepEqual(relayRange('{"from":3,"to":9,"passed":[]}'), { from: 3, to: 9 })
  assert.equal(relayRange('{"replies":[],"passed":[]}'), undefined)
  assert.equal(relayRange('{"replies":[{"botId":"a","text":"cu'), undefined)
})

// A window that only read a book takes over writing when the other host goes: what that
// host wrote meanwhile is read again before anything new is added.
test('a reader that takes over writing reads the book again first', async (t) => {
  const writer = host(t)
  writer.rt.ledger.append('group-r1', { seq: 1, text: 'one' })
  await writer.rt.ledger.flush()
  let reading = 'another dsh holds the team'
  const reader = host(t, { home: writer.home, readOnly: () => reading })
  assert.equal(reader.rt.ledger.lastSeq('group-r1'), 1)
  writer.rt.ledger.append('group-r1', { seq: 2, text: 'two' })
  await writer.rt.ledger.flush()
  reading = undefined
  reader.rt.ledger.append('group-r1', { seq: 3, text: 'three' })
  await reader.rt.ledger.flush()
  assert.deepEqual(reader.rt.ledger.records('group-r1').map(record => record.seq), [1, 2, 3])
  assert.deepEqual(parseBook(readFileSync(writer.file('group-r1'), 'utf8')).map(record => record.seq), [1, 2, 3])
})

test('a write that does not reach the disk is reported to whoever waits for it', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async (t) => {
  const { rt, home } = host(t)
  mkdirSync(join(home, 'ledger'), { recursive: true })
  chmodSync(join(home, 'ledger'), 0o500)
  try {
    rt.ledger.append('pair-a-b', { id: 'x', text: 'hello' })
    await assert.rejects(rt.ledger.written('pair-a-b'))
    // The queue goes on for the next record, and memory holds only what landed.
    await rt.ledger.flush('pair-a-b')
    assert.deepEqual(rt.ledger.records('pair-a-b'), [])
  } finally {
    chmodSync(join(home, 'ledger'), 0o700)
  }
  // Sent again, it is written again.
  rt.ledger.append('pair-a-b', { id: 'x', text: 'hello' })
  await rt.ledger.written('pair-a-b')
  assert.deepEqual(parseBook(readFileSync(join(home, 'ledger', 'pair-a-b.jsonl'), 'utf8')).map(record => record.id), ['x'])
})
