import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileMentionSource } from '../src/client/mention-source.js'

// The chat node's inline-file resolver comes from the shared `chatFileMentions`
// service; a view that shadows DSH's node must read it itself.
test('a shadowed chat node reads the shared file-mention service', () => {
  const calls = []
  const service = { forClosing: (...args) => { calls.push(args); return { resolve: () => undefined } } }
  const ctx = { get: name => (name === 'chatFileMentions' ? service : undefined) }
  const source = fileMentionSource(ctx, 'session-1')
  const owner = { turn: {}, seq: 7, openFile: () => {} }
  const trigger = () => undefined
  const resolver = source(owner, trigger)
  assert.equal(typeof resolver.resolve, 'function')
  assert.deepEqual(calls, [[owner, 'session-1', trigger]])
})

test('without the service there is no resolver, not a broken one', () => {
  const source = fileMentionSource({ get: () => undefined }, 'session-1')
  assert.equal(source({ turn: {}, seq: 1 }, () => undefined), undefined)
})

test('the service declining a closing message stays undefined', () => {
  const source = fileMentionSource({ get: () => ({ forClosing: () => undefined }) }, 'session-1')
  assert.equal(source({ turn: {}, seq: 1 }), undefined)
})
