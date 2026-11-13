import assert from 'node:assert/strict'
import { test } from 'node:test'
import { capabilityStatusOf, capabilityStatusesFor } from './capabilities.ts'

// Recorded from a running computer: `state.capabilityStatuses` of a `state` answer,
// after a skill and a broken MCP server were attached to the Main Bot and a turn ran, so
// one status is the mounted skill's and the other is a real mount failure. The Bot's
// layer exists even when it carries nothing: with nothing attached the answer was
// `{ "<botId>": {} }` (also recorded).
const botId = 'session-e8e65692-0381-4857-9bf1-6122707124df'
const recorded = {
  [botId]: {
    'release-notes': { state: 'ready' },
    'broken-mcp': { state: 'error', error: 'mcp-client(broken-mcp): initial connection or tool synchronization failed: Connection closed' },
  },
}

test('a capability status comes from the current Bot\'s layer', () => {
  const statuses = capabilityStatusesFor(recorded, botId)
  assert.deepEqual(Object.keys(statuses).sort(), ['broken-mcp', 'release-notes'])
  assert.deepEqual(statuses['release-notes'], { state: 'ready' })
  assert.deepEqual(capabilityStatusOf(recorded, botId, 'release-notes'), { state: 'ready' })
  assert.equal(capabilityStatusOf(recorded, botId, 'broken-mcp')?.state, 'error')
  assert.equal(capabilityStatusOf(recorded, botId, 'broken-mcp')?.error, 'mcp-client(broken-mcp): initial connection or tool synchronization failed: Connection closed')
})

test('the old top-level read finds no status — the layer is the Bot', () => {
  // What the screen did before #1523: `statuses[item.name]` on `capabilityStatuses`
  // itself. A capability is named `release-notes`, not a Bot id, so nothing is found;
  // a reader that went back to this shape would get no status here.
  const flat = recorded as unknown as Record<string, { state?: string; error?: string }>
  assert.equal(flat['release-notes'], undefined)
  assert.equal(capabilityStatusOf(recorded, botId, 'release-notes')?.state, 'ready')
})

test('a capability this Bot does not carry, or an empty layer, is unknown', () => {
  assert.equal(capabilityStatusOf(recorded, botId, 'browse-the-web'), undefined)
  assert.deepEqual(capabilityStatusesFor({ [botId]: {} }, botId), {})
  assert.equal(capabilityStatusOf({ [botId]: {} }, botId, 'release-notes'), undefined)
})

test('another Bot\'s layer is not read for this Bot', () => {
  const other = { 'another-bot': { 'release-notes': { state: 'needs-approval' } } }
  assert.deepEqual(capabilityStatusesFor(other, botId), {})
  assert.equal(capabilityStatusOf(other, botId, 'release-notes'), undefined)
  assert.deepEqual(capabilityStatusesFor(other, 'another-bot'), { 'release-notes': { state: 'needs-approval' } })
})

test('a missing answer, a missing Bot layer, or another shape is unknown instead of throwing', () => {
  for (const view of [undefined, null, {}, 'release-notes', 7, true, [], { [botId]: null }, { [botId]: [] }, { [botId]: 'ready' }]) {
    assert.deepEqual(capabilityStatusesFor(view, botId), {}, JSON.stringify(view))
    assert.equal(capabilityStatusOf(view, botId, 'release-notes'), undefined)
  }
  for (const id of [undefined, null, '']) {
    assert.deepEqual(capabilityStatusesFor(recorded, id), {})
  }
})

test('an entry the host would not write is ignored', () => {
  const view = { [botId]: { 'release-notes': 'ready', 'broken-mcp': { state: 'error', error: 'x' } } }
  assert.deepEqual(capabilityStatusesFor(view, botId), { 'broken-mcp': { state: 'error', error: 'x' } })
})
