import assert from 'node:assert/strict'
import { test } from 'node:test'
import { confirmDanger } from './confirm-danger.web.ts'

test('browser destructive actions run only after confirmation, with optional details', t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const prompts: string[] = []
  let accepted = false
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { confirm: (text: string) => { prompts.push(text); return accepted } } })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  let calls = 0
  const run = () => { calls++ }
  confirmDanger('Delete Bot?', 'Delete', run)
  assert.equal(calls, 0)
  accepted = true
  confirmDanger('Delete secret?', 'Delete', run, 'Cannot undo')
  assert.equal(calls, 1)
  confirmDanger('Clear diagnostics?', 'Clear', run, '')
  assert.equal(calls, 2)
  assert.deepEqual(prompts, ['Delete Bot?', 'Delete secret?\n\nCannot undo', 'Clear diagnostics?'])
  assert.throws(() => confirmDanger('Delete?', 'Delete', () => { throw new Error('failed action') }), /failed action/)
})
