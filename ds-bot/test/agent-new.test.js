import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentSessionToReuse, singleFlight } from '../src/client/agent-new.js'

// #1225: "+ new session" on the DSH Agent kept making empty Sessions. The decision used
// to be the shell's blank flag alone, which a Session created a moment ago does not carry
// — it is not in the list yet, or it has bootstrap events — so the next click made another.
test('a new-session click reuses the Session this window just created', () => {
  // The create has finished but the shell's list has not shown the Session yet.
  assert.equal(agentSessionToReuse({ draft: 's-new', draftRow: undefined }), 's-new')
  // The list has it, and it is still untouched.
  assert.equal(agentSessionToReuse({ draft: 's-new', draftRow: { blank: true } }), 's-new')
  // The user wrote in it: it is a conversation now, so a new click starts a real one.
  assert.equal(agentSessionToReuse({ draft: 's-new', draftRow: { blank: false } }), undefined)
  // Nothing created by this window: the Agent's latest blank Session still counts.
  assert.equal(agentSessionToReuse({ latest: 's-last', latestRow: { blank: true } }), 's-last')
  assert.equal(agentSessionToReuse({ latest: 's-last', latestRow: { blank: false } }), undefined)
  assert.equal(agentSessionToReuse({ latest: 's-last', latestRow: undefined }), undefined)
  // A blank Session of this window wins over the Agent's latest one.
  assert.equal(agentSessionToReuse({ draft: 's-new', draftRow: { blank: true }, latest: 's-last', latestRow: { blank: true } }), 's-new')
  // An Agent with nothing at all still creates one.
  assert.equal(agentSessionToReuse({}), undefined)
})

test('a second new-session click while the first is in flight lands on the same call', async () => {
  const map = new Map()
  let runs = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const run = async () => { runs += 1; await gate; return `s-${runs}` }
  const first = singleFlight(map, 'agent-1', run)
  const second = singleFlight(map, 'agent-1', run)
  const third = singleFlight(map, 'agent-1', run)
  assert.equal(first, second, 'the second click gets the call already running')
  assert.equal(first, third)
  release()
  assert.deepEqual(await Promise.all([first, second, third]), ['s-1', 's-1', 's-1'])
  assert.equal(runs, 1, 'one create for three clicks')
  // The entry cleared: the next click starts its own call.
  assert.equal(await singleFlight(map, 'agent-1', run), 's-2')
  assert.equal(runs, 2)
  assert.equal(map.size, 0)
})

test('a failed create does not block the next click', async () => {
  const map = new Map()
  await assert.rejects(singleFlight(map, 'agent-1', async () => { throw new Error('the host said no') }), /the host said no/)
  assert.equal(map.size, 0, 'the in-flight entry is gone after a failure')
  assert.equal(await singleFlight(map, 'agent-1', async () => 's-1'), 's-1')
})

test('two Agents create their own Sessions at the same time', async () => {
  const map = new Map()
  const created = await Promise.all([
    singleFlight(map, 'agent-1', async () => 'one'),
    singleFlight(map, 'agent-2', async () => 'two'),
  ])
  assert.deepEqual(created, ['one', 'two'])
})
