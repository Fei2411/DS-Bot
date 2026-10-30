import assert from 'node:assert/strict'
import { test } from 'node:test'
import { editLines, lineDiff, proposalPlacement } from '../src/client/learning-card-model.js'

const turns = new Map([
  [1, { turn: 1, end: { time: 100 }, status: 'closed' }],
  [2, { turn: 2, end: { time: 200 }, status: 'closed' }],
  [3, { turn: 3, status: 'open' }],
])

test('a proposal belongs to the latest closed turn ending before its timestamp', () => {
  assert.deepEqual(proposalPlacement({ at: 150 }, turns), { kind: 'turn', turn: 1 })
  assert.deepEqual(proposalPlacement({ at: 200 }, turns), { kind: 'turn', turn: 2 })
})

test('a proposal without an earlier closed turn falls back to the latest closed turn', () => {
  assert.deepEqual(proposalPlacement({ at: 50 }, turns), { kind: 'turn', turn: 2 })
})

test('a proposal uses the dock when there are no closed turns', () => {
  assert.deepEqual(proposalPlacement({ at: 150 }, new Map()), { kind: 'dock' })
  assert.deepEqual(proposalPlacement({ at: 150 }, new Map([[3, { turn: 3, status: 'open' }]])), { kind: 'dock' })
})

test('a new skill diff marks every line as added', () => {
  assert.deepEqual(lineDiff('', 'a\nb\n'), [
    { kind: 'added', line: 'a', number: 1 },
    { kind: 'added', line: 'b', number: 2 },
  ])
})

test('a skill update diff keeps unchanged lines and shows removals', () => {
  assert.deepEqual(lineDiff('Check tests\nRequire approval', 'Check tests\nRun lint'), [
    { kind: 'same', line: 'Check tests', number: 1 },
    { kind: 'removed', line: 'Require approval' },
    { kind: 'added', line: 'Run lint', number: 2 },
  ])
})

test('a large skill rewrite falls back to a block diff quickly', () => {
  const before = Array.from({ length: 4000 }, (_, i) => `old ${i}`).join('\n')
  const after = Array.from({ length: 4000 }, (_, i) => `new ${i}`).join('\n')
  const started = Date.now()
  const rows = lineDiff(before, after)
  assert.ok(Date.now() - started < 1000)
  assert.equal(rows.length, 8000)
  assert.ok(rows.slice(0, 4000).every(row => row.kind === 'removed'))
  assert.deepEqual(rows[4000], { kind: 'added', line: 'new 0', number: 1 })
})

test('a skill update keeps a long shared head and tail unchanged', () => {
  const head = Array.from({ length: 3000 }, (_, i) => `head ${i}`)
  const tail = Array.from({ length: 3000 }, (_, i) => `tail ${i}`)
  const rows = lineDiff([...head, 'before', ...tail].join('\n'), [...head, 'after', ...tail].join('\n'))
  assert.equal(rows.filter(row => row.kind === 'same').length, 6000)
  assert.deepEqual(rows.slice(3000, 3002), [{ kind: 'removed', line: 'before' }, { kind: 'added', line: 'after', number: 3001 }])
  assert.deepEqual(rows.at(-1), { kind: 'same', line: 'tail 2999', number: 6001 })
})

test('AGENTS.md edit previews keep the blank lines the edit writes', () => {
  assert.deepEqual(editLines('\n'), ['', ''])
  assert.deepEqual(editLines('Rule\n\n'), ['Rule', '', ''])
  assert.deepEqual(editLines(undefined), [])
})
