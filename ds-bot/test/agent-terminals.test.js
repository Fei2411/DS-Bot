import assert from 'node:assert/strict'
import { test } from 'node:test'
import { watchAgentTerminals } from '../src/client/agent-terminals.js'

const ACTIONS = 'conversation.session.header.actions'
const fakeSlots = () => {
  const entries = []
  const listeners = new Set()
  const changed = () => { for (const listener of listeners) listener() }
  return {
    listeners,
    entries: name => (name === ACTIONS ? entries : []),
    subscribe: (name, listener) => { assert.equal(name, ACTIONS); listeners.add(listener); return () => listeners.delete(listener) },
    add: (entry) => { entries.push(entry); changed() },
    remove: (entry) => { entries.splice(entries.indexOf(entry), 1); changed() },
  }
}
const opener = log => ({
  options: { id: 'agent-terminals' },
  inject: sessionId => ({ watchAgentTerminals: () => { log.push(`watch ${sessionId}`); return () => log.push(`release ${sessionId}`) } }),
})

// #1826: the Bot header replaces DSH's, whose actions list holds the terminal plugin's opener.
test('the Bot header watches the shown Session\'s Agent terminals through the terminal plugin\'s entry only', () => {
  const log = []
  const slots = fakeSlots()
  slots.add({ options: { id: 'job-list' }, inject: () => { throw new Error('other header actions stay out of the Bot header') } })
  slots.add(opener(log))
  const stop = watchAgentTerminals(slots, 's1')
  assert.deepEqual(log, ['watch s1'])
  slots.add({ options: { id: 'subagent-catalog' } })
  assert.deepEqual(log, ['watch s1'], 'another header action does not restart the watch')
  stop()
  assert.deepEqual(log, ['watch s1', 'release s1'])
  assert.equal(slots.listeners.size, 0)
})

test('the watch follows the terminal plugin arriving late and reloading, and does nothing without it', () => {
  const log = []
  const slots = fakeSlots()
  const stop = watchAgentTerminals(slots, 's1')
  assert.deepEqual(log, [])
  const first = opener(log)
  slots.add(first)
  slots.remove(first)
  slots.add(opener(log))
  stop()
  assert.deepEqual(log, ['watch s1', 'release s1', 'watch s1', 'release s1'])
})

test('a failing opener is reported and leaves the header standing', () => {
  const slots = fakeSlots()
  const errors = []
  slots.add({ options: { id: 'agent-terminals' }, inject: () => { throw new Error('boom') } })
  const stop = watchAgentTerminals(slots, 's1', error => errors.push(error.message))
  assert.deepEqual(errors, ['boom'])
  stop()
  assert.equal(slots.listeners.size, 0)
})
