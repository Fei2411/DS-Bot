import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SIDEBAR_KINDS, filterSidebarEntries, sidebarEntries } from '../src/client/sidebar-order.js'

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
  assert.deepEqual(ids(filterSidebarEntries(entries, 'room')), ['r1', 'r2'])
})

test('a pinned row stays above a newer one', () => {
  const roster = rosterOf({ rooms: [room('r1', { pinned: true }), room('r2')] })
  const entries = sidebarEntries(roster, { r1: 1, r2: 99 })
  assert.equal(entries[0].item.id, 'r1')
})

test('narrowing keeps one kind and drops the rest', () => {
  const entries = [
    { kind: 'bot', item: { id: 'b' }, at: 1 },
    { kind: 'room', item: { id: 'r' }, at: 2 },
    { kind: 'agent', item: { id: 'a' }, at: 3 },
  ]
  assert.deepEqual(SIDEBAR_KINDS, ['all', 'bot', 'room'])
  assert.equal(filterSidebarEntries(entries, 'all').length, 3)
  assert.deepEqual(ids(filterSidebarEntries(entries, 'bot')), ['b'])
  assert.deepEqual(ids(filterSidebarEntries(entries, 'room')), ['r'])
  assert.equal(filterSidebarEntries(entries, undefined), entries)
})
