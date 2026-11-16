import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install as installParts } from '../src/host/parts.js'

// The least an rt needs for displayItems: no live Session, so the page reader
// stamps what the events say (the same stand-in bot-messages.test.js uses).
function displayItems(events) {
  const writer = { id: 'b', name: 'Writer', createdAt: 1, sessionId: 'b2' }
  const rt = {
    ctx: { on() {}, effect() {}, get() {} },
    config: {},
    state: { exchangeTurns: {} },
    chatOwners: new Map([['b2', 'b']]),
    pastOwners: new Map(),
    botOf: id => (id === 'b' ? writer : undefined),
    roomOf: () => undefined,
    chatOf: () => 'b2',
    resolveAgent: async id => ({ session: { id, seq: 9 } }),
  }
  installParts(rt)
  return rt.displayItems('b2', events)
}

test('a user message that carried a file shows the file beside its text', () => {
  const items = displayItems([
    {
      type: 'user/message', seq: 1, time: 10,
      data: {
        content: [
          { type: 'text', text: 'read this' },
          { type: 'file', attachment: { attachmentId: 'sha256:abc', name: 'التقرير.pdf', bytes: 2048 } },
        ],
        source: { kind: 'user' },
      },
    },
  ])
  assert.deepEqual(items.map(item => [item.kind, item.text, item.files]), [
    ['user', 'read this', [{ attachmentId: 'sha256:abc', name: 'التقرير.pdf', bytes: 2048 }]],
  ])
})

test('a user message without a file has no files field, so the client shows no card', () => {
  const items = displayItems([
    { type: 'user/message', seq: 1, time: 10, data: { content: [{ type: 'text', text: 'just words' }], source: { kind: 'user' } } },
  ])
  assert.deepEqual(items, [{ kind: 'user', text: 'just words', seq: 1, time: 10 }])
})
