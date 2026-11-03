import test from 'node:test'
import assert from 'node:assert/strict'
import { opensReply, thinkingStep, turnReasoning } from '../src/client/turn-reasoning.js'

const step = (n, blocks, status = 'settled') => ({ turn: 1, step: n, status, blocks })
const think = text => ({ kind: 'reasoning', text })
const tool = { kind: 'tool-call', name: 'read' }

test('a long tool Turn shows its reasoning once, on the last step, in order', () => {
  const steps = Array.from({ length: 24 }, (_, i) => step(i + 1, [think(`Reasoning ${i + 1}`), tool]))
  const shown = steps.map(current => turnReasoning(steps, current))
  assert.equal(shown.filter(Boolean).length, 1)
  assert.equal(shown[23], steps.map((_, i) => `Reasoning ${i + 1}`).join('\n\n'))
})

test('the row sits on the last step with reasoning, next to the reply', () => {
  const steps = [step(1, [{ kind: 'text', text: 'Looking' }, tool]), step(2, [think('B'), tool]), step(3, [think('C'), { kind: 'text', text: 'Done' }])]
  assert.deepEqual(steps.map(current => turnReasoning(steps, current)), ['', '', 'B\n\nC'])
  // A Turn whose only reasoning step came first keeps the row there.
  const early = [step(1, [think('B'), tool]), step(2, [tool]), step(3, [{ kind: 'text', text: 'Done' }])]
  assert.deepEqual(early.map(current => turnReasoning(early, current)), ['B', '', ''])
})

test('reasoning still in progress shows while its step thinks', () => {
  const steps = [step(1, [think('A'), tool]), step(2, [think('B')], 'running')]
  assert.equal(turnReasoning(steps, steps[0]), '')
  assert.equal(turnReasoning(steps, steps[1]), 'A\n\nB')
  assert.equal(turnReasoning([step(1, [think('A')], 'running')], step(1, [think('A')], 'running')), 'A')
  steps[1].blocks.push({ kind: 'text', text: 'Reply' })
  assert.equal(turnReasoning(steps, steps[1]), 'A\n\nB')
})

test('the live step is the one still thinking', () => {
  const steps = [step(1, [think('A'), tool]), step(2, [think('B')], 'running')]
  assert.equal(thinkingStep(steps), steps[1])
  // Reasoning that moved on to its reply no longer ticks.
  steps[1].blocks.push({ kind: 'text', text: 'Reply' })
  assert.equal(thinkingStep(steps), undefined)
  // A running step without reasoning yet is not thinking either.
  assert.equal(thinkingStep([step(3, [tool], 'running')]), undefined)
  assert.equal(thinkingStep(steps.slice(0, 1)), undefined)
})

test('a `<signature>` block at the head of reasoning never shows', () => {
  // A signature alone leaves nothing to show, like DSH's hidden reasoning row.
  assert.equal(turnReasoning([], step(1, [think('<signature>abc123</signature>')])), '')
  assert.equal(turnReasoning([], step(1, [think('<signature>abc123</signature>\n\nReal thought')])), 'Real thought')
  assert.equal(turnReasoning([], step(1, [think('<signature>abc123</signature>\r\n\r\nReal thought')])), 'Real thought')
  // A stream that has only reached inside the tag shows nothing yet.
  assert.equal(turnReasoning([], step(1, [think('<sign')])), '')
  assert.equal(turnReasoning([], step(1, [think('<signature>abc123')])), '')
  // Text that only looks like it stays untouched.
  assert.equal(turnReasoning([], step(1, [think('A <signature> mention')])), 'A <signature> mention')
})

test('a step outside the loaded Turn list shows only its own reasoning', () => {
  const current = step(1, [think(' A ')])
  assert.equal(turnReasoning([], current), 'A')
})

test('a reply opens on its first text or on its reasoning row, whichever comes first', () => {
  const opener = steps => steps.findIndex(current => opensReply(steps, current))
  // A word before the tools opens the reply, ahead of the reasoning on the last step.
  assert.equal(opener([step(1, [{ kind: 'text', text: 'Looking' }, tool]), step(2, [think('B'), tool]), step(3, [think('C'), { kind: 'text', text: 'Done' }])]), 0)
  // Reasoning that shows before any text opens it.
  assert.equal(opener([step(1, [think('B'), tool]), step(2, [tool]), step(3, [{ kind: 'text', text: 'Done' }])]), 0)
  // Tools alone open nothing; the step that answers does.
  assert.equal(opener([step(1, [tool]), step(2, [tool]), step(3, [{ kind: 'text', text: 'Done' }])]), 2)
  assert.equal(opener([step(1, [tool])]), -1)
})

test("with the reasoning hidden, only a step's own text opens the reply", () => {
  const opener = steps => steps.findIndex(current => opensReply(steps, current, false))
  // A reasoning-only first step no longer opens it: the step that answers does.
  assert.equal(opener([step(1, [think('B'), tool]), step(2, [tool]), step(3, [{ kind: 'text', text: 'Done' }])]), 2)
  assert.equal(opener([step(1, [{ kind: 'text', text: 'Looking' }, tool]), step(2, [think('B'), tool]), step(3, [think('C'), { kind: 'text', text: 'Done' }])]), 0)
  assert.equal(opener([step(1, [think('B'), tool])]), -1)
})
