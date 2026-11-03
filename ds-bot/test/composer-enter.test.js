import assert from 'node:assert/strict'
import { test } from 'node:test'
import { insertComposerNewline } from '../src/client/enter-key.js'

function bench({ composing = false, listbox = false, actions = true } = {}) {
  const inserted = []
  const inputActions = actions ? {
    captureInsertion: () => ({ draftRev: 1 }),
    insertText: (text, span) => { inserted.push([text, span]); return true },
  } : undefined
  const target = {
    ownerDocument: { querySelector: selector => selector === '[role="listbox"]' && listbox ? {} : null },
    closest(selector) {
      if (selector === '[data-composer-card] [role="textbox"]') return this
      if (selector === '[data-composer-composing]') return composing ? this : null
      return null
    },
  }
  const event = {
    key: 'Enter', target, prevented: 0, stopped: 0,
    preventDefault() { this.prevented += 1 },
    stopImmediatePropagation() { this.stopped += 1 },
  }
  return { event, inputActions, inserted }
}

test('plain Enter inserts a newline at the captured caret and stops submission', () => {
  const { event, inputActions, inserted } = bench()
  assert.equal(insertComposerNewline(event, inputActions), true)
  assert.deepEqual(inserted, [['\n', { draftRev: 1 }]])
  assert.equal(event.prevented, 1)
  assert.equal(event.stopped, 1)
})

test('IME confirmation, an open suggestion menu, and modified Enter pass through', () => {
  for (const setup of [
    { event: { isComposing: true } },
    { event: { keyCode: 229 } },
    { event: { shiftKey: true } },
    { event: { ctrlKey: true } },
    { event: { metaKey: true } },
    { event: { altKey: true } },
    { event: { getModifierState: key => key === 'AltGraph' } },
    { composing: true },
    { listbox: true },
  ]) {
    const { event, inputActions, inserted } = bench(setup)
    Object.assign(event, setup.event)
    assert.equal(insertComposerNewline(event, inputActions), false)
    assert.deepEqual(inserted, [])
    assert.equal(event.prevented, 0)
    assert.equal(event.stopped, 0)
  }
})

test('other keys, other fields, and a missing input face stay untouched', () => {
  const otherKey = bench()
  otherKey.event.key = 'a'
  assert.equal(insertComposerNewline(otherKey.event, otherKey.inputActions), false)

  const otherField = bench()
  otherField.event.target.closest = () => null
  assert.equal(insertComposerNewline(otherField.event, otherField.inputActions), false)

  const noActions = bench({ actions: false })
  assert.equal(insertComposerNewline(noActions.event, noActions.inputActions), false)
  assert.equal(noActions.event.prevented, 0)
})
