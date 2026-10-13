import assert from 'node:assert/strict'
import { test } from 'node:test'
import { relayPart, relaysBefore, toolArgs, toolName } from '../src/client/text.js'

const argsRaw = JSON.stringify({ name: 'GITHUB_TOKEN', purpose: 'GitHub', questions: [{ question: 'Which?' }] })

test('a finished call that carries its name and arguments only under `call` is still read', () => {
  const root = { kind: 'tool-result', callId: 'c1', call: { name: 'request_secret', argsRaw }, content: [] }
  const args = toolArgs(root)
  assert.equal(toolName(root), 'request_secret')
  assert.equal(args.text('name'), 'GITHUB_TOKEN')
  assert.deepEqual(args.value('questions'), [{ question: 'Which?' }])
  assert.equal(args.text('questions'), undefined)
  assert.equal(args.text('missing'), undefined)
})

test('a running call is read from its own name and raw arguments', () => {
  const root = { phase: 'start', callId: 'c1', name: 'request_secret', argsRaw }
  assert.equal(toolName(root), 'request_secret')
  assert.equal(toolArgs(root).text('name'), 'GITHUB_TOKEN')
})

test('a node with an argument reader uses the reader', () => {
  const reader = { text: key => (key === 'to' ? 'Coder' : undefined), value: key => (key === 'to' ? 'Coder' : undefined) }
  const root = { kind: 'tool-result', name: 'message_bot', args: reader, call: { name: 'message_bot', argsRaw: '{"to":"Other"}' } }
  assert.equal(toolName(root), 'message_bot')
  assert.equal(toolArgs(root).text('to'), 'Coder')
  assert.equal(toolArgs(root).value('to'), 'Coder')
})

test('an empty name falls back to the call, and unreadable arguments read as absent', () => {
  const root = { kind: 'tool-result', name: '', call: { name: 'ask_user', argsRaw: '{"question":' } }
  assert.equal(toolName(root), 'ask_user')
  assert.equal(toolArgs(root).text('question'), undefined)
  assert.equal(toolArgs({ kind: 'tool-result', call: null }).value('x'), undefined)
  assert.equal(toolArgs({ argsRaw: '[1]' }).value('0'), undefined)
})

const relay = (time, role = 'request', over = {}) => ({
  time, source: { kind: 'bot', role, senderSessionId: 'session-sender', ...over },
})
const stepAt = (step, time, text = 'some text') => ({ step, time, blocks: text === null ? [{ kind: 'tool-call' }] : [{ kind: 'text', text }] })

test('a relay between steps attaches to the step that follows it only', () => {
  const steps = [stepAt(1, 10), stepAt(2, 20), stepAt(3, 30)]
  const contexts = [relay(15), relay(25)]
  assert.equal(relaysBefore(contexts, steps, steps[0]).length, 0)
  assert.deepEqual(relaysBefore(contexts, steps, steps[1]), [contexts[0]])
  assert.deepEqual(relaysBefore(contexts, steps, steps[2]), [contexts[1]])
})

test('a relay before a tool-only step attaches to the next step that renders', () => {
  const steps = [stepAt(1, 10), stepAt(2, 20, null), stepAt(3, 30, null), stepAt(4, 40)]
  const contexts = [relay(15)]
  assert.deepEqual(relaysBefore(contexts, steps, steps[3]), [contexts[0]])
})

test('a relay before the first step attaches to it', () => {
  const steps = [stepAt(1, 10), stepAt(2, 20)]
  const contexts = [relay(5)]
  assert.deepEqual(relaysBefore(contexts, steps, steps[0]), [contexts[0]])
  assert.equal(relaysBefore(contexts, steps, steps[1]).length, 0)
})

test('the step is found by its number when the cell holds a different copy', () => {
  const steps = [stepAt(1, 10), stepAt(2, 20), stepAt(3, 30)]
  const contexts = [relay(15)]
  assert.deepEqual(relaysBefore(contexts, steps, { ...steps[1] }), [contexts[0]])
})

test('a relay sharing the previous step’s time attaches to the next step', () => {
  const steps = [stepAt(1, 10), stepAt(2, 20)]
  const contexts = [relay(10)]
  assert.deepEqual(relaysBefore(contexts, steps, steps[1]), [contexts[0]])
})

test('relayPart puts the line in the step’s first cell', () => {
  const thinking = { step: 1, time: 10, blocks: [{ kind: 'reasoning', text: 'thought' }, { kind: 'text', text: 'reply' }] }
  const plain = { step: 2, time: 20, blocks: [{ kind: 'text', text: 'reply' }] }
  const blank = { step: 3, time: 30, blocks: [{ kind: 'reasoning', text: '  ' }] }
  assert.equal(relayPart(thinking, 'reasoning'), true)
  assert.equal(relayPart(thinking, 'response'), false)
  assert.equal(relayPart(plain, 'response'), true)
  assert.equal(relayPart(plain, 'reasoning'), false)
  assert.equal(relayPart(blank, 'response'), true)
  assert.equal(relayPart(thinking, undefined), true)
  assert.equal(relayPart(plain, undefined), true)
})

test('two relays before one step both return, in order', () => {
  const steps = [stepAt(1, 10), stepAt(2, 30)]
  const contexts = [relay(12, 'request'), relay(18, 'reply')]
  assert.deepEqual(relaysBefore(contexts, steps, steps[1]), [contexts[0], contexts[1]])
})

test('non-relay context and ds-bot package sources are ignored', () => {
  const steps = [stepAt(1, 10), stepAt(2, 30)]
  const contexts = [
    relay(12, 'request', { handoff: true }),
    relay(14, 'kickoff'),
    relay(16, 'room'),
    relay(18, 'secret'),
    relay(22, 'request', { senderSessionId: undefined }),
    { time: 24, source: { kind: 'agent-instructions' } },
    { time: 26, source: null },
    relay(27, 'request', { deferred: true }),
    relay(28, 'request'),
  ]
  assert.deepEqual(relaysBefore(contexts, steps, steps[1]), [contexts[8]])
})
