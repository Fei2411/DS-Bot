import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sidebarEntries } from '../src/client/sidebar-order.js'

const bot = (id, extra = {}) => ({ id, name: id, sessionId: id, createdAt: 1, ...extra })
const room = (id, extra = {}) => ({ id, name: id, createdAt: 1, ...extra })

const rosterOf = (over = {}) => ({
  mainBotId: 'main',
  bots: [bot('main'), bot('old'), bot('active')],
  rooms: [room('r1'), room('r2')],
  agents: [],
  ...over,
})

const ids = entries => entries.map(entry => entry.item.id)

test('a row sorts by its last message, not by when it was made', () => {
  const roster = rosterOf()
  const entries = sidebarEntries(roster, { old: 10, active: 99, r1: 20, r2: 30 })
  assert.deepEqual(ids(entries), ['active', 'r2', 'r1', 'old'])
})

// A group's Session id is not always the room id; reading the wrong key left the
// group at its creation time while Bots moved.
test('a group sorts by its Session id, not its room id', () => {
  const roster = rosterOf({ rooms: [room('r1', { sessionId: 's-r1', createdAt: 1 }), room('r2', { createdAt: 1 })] })
  const entries = sidebarEntries(roster, { 's-r1': 99, r1: 0, r2: 20 })
  assert.deepEqual(ids(entries.filter(entry => entry.kind === 'room')), ['r1', 'r2'])
})

test('a pinned row stays above a newer one', () => {
  const roster = rosterOf({ rooms: [room('r1', { pinned: true }), room('r2')] })
  const entries = sidebarEntries(roster, { r1: 1, r2: 99 })
  assert.equal(entries[0].item.id, 'r1')
})

test('an Agent sorts by its newest Session, and the Main Bot is not a row', () => {
  const roster = rosterOf({ agents: [{ id: 'a1', createdAt: 1, sessions: ['x', 'y'] }, { id: 'a2', createdAt: 5, sessions: ['z'] }] })
  const entries = sidebarEntries(roster, { r1: 1, r2: 2, x: 40, y: 60, z: 10 })
  assert.deepEqual(ids(entries.filter(entry => entry.kind === 'agent')), ['a1', 'a2'])
  assert.ok(!ids(entries).includes('main'))
})
