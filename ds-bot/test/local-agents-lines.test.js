import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lineSplitter } from '../src/host/local-agents/lines.js'

function split(chunks) {
  const lines = []
  const feed = lineSplitter(line => lines.push(line))
  for (const chunk of chunks) feed(chunk)
  return lines
}

test('a line split across chunks comes out whole', () => {
  assert.deepEqual(split(['{"a":', '1}\n{"b"', ':2}', '\n']), ['{"a":1}', '{"b":2}'])
})

test('CRLF endings and blank lines are dropped', () => {
  assert.deepEqual(split(['one\r\n\r\n  two  \r', '\n\n']), ['one', 'two'])
})

test('many lines in one chunk come out in order', () => {
  const lines = Array.from({ length: 500 }, (_, i) => `{"n":${i}}`)
  assert.deepEqual(split([lines.join('\n') + '\n']), lines)
})

test('one huge line in many chunks is joined once its newline arrives', () => {
  const line = `{"data":"${'x'.repeat(4_000_000)}"}`
  const chunks = []
  for (let at = 0; at < line.length; at += 65_536) chunks.push(line.slice(at, at + 65_536))
  chunks.push('\n{"next":true}\n')
  assert.deepEqual(split(chunks), [line, '{"next":true}'])
})

test('a last line without a newline is held back', () => {
  assert.deepEqual(split(['done\npartial']), ['done'])
})
