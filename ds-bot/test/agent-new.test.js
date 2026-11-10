import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentSessionToReuse, singleFlight } from '../src/client/agent-new.js'

test('reuse the just-created Session until the DSH list can decide whether it is blank', () => {
  const existing = { blank: false, displayTitle: 'Fix the build' }
  const blank = { blank: true, displayTitle: 'workspace' }
  assert.equal(agentSessionToReuse({ byId: { old: existing } }, 'old', 'new'), 'new')
  assert.equal(agentSessionToReuse({ byId: { new: blank } }, 'new', 'new'), 'new')
  assert.equal(agentSessionToReuse({ byId: { new: { ...blank, blank: false } } }, 'new', 'new'), undefined)
  assert.equal(agentSessionToReuse({ byId: { old: existing, new: blank } }, 'old', 'new'), undefined)
  assert.equal(agentSessionToReuse({ byId: { new: blank } }, 'new'), 'new')
  assert.equal(agentSessionToReuse({ byId: {} }), undefined)
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
