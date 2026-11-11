// Deleting a Bot or a group chat removes it from the sidebar before the host answers,
// closes the panel on it, and reads the team again if the host refused.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EMPTY_ROSTER, createSource, indexRoster } from '../src/client/sources.js'
import { teamActions } from '../src/client/team-actions.js'

function bench({ refuse = false } = {}) {
  const roster = createSource(indexRoster({
    ...EMPTY_ROSTER,
    mainBotId: 'main',
    mainBotIds: ['main'],
    bots: [
      { id: 'main', name: 'Main', createdAt: 1 },
      { id: 'writer', name: 'Writer', createdAt: 2 },
    ],
    rooms: [{ id: 'room1', name: 'Team', members: ['main', 'writer'], createdAt: 3 }],
  }))
  const ui = createSource({ details: 'room1', view: 'details', renaming: true, tab: null, side: null })
  const sent = []
  let finish
  let refreshed = 0
  const call = (name, body) => {
    sent.push([name, body])
    if (refuse) return Promise.reject(Object.assign(new Error('refused'), { code: 'bot/refused' }))
    return new Promise((resolve) => { finish = () => resolve({}) })
  }
  const after = promise => promise.then(value => value)
  const refresh = () => { refreshed++; return Promise.resolve() }
  const actions = teamActions({ call, after, refresh, partFor: id => id, roster, ui })
  return { actions, roster, ui, sent, finish: () => finish?.(), refreshes: () => refreshed }
}

test('a deleted group leaves the sidebar before the host answers', async () => {
  const { actions, roster, ui, sent, finish } = bench()
  const done = actions.deleteRoom('room1')
  assert.deepEqual(sent, [['delete-room', { id: 'room1' }]])
  assert.deepEqual(roster.getSnapshot().rooms, [])
  assert.equal(roster.getSnapshot().roomsById.room1, undefined)
  // The panel cannot stay open on a chat that is gone.
  assert.equal(ui.getSnapshot().details, null)
  finish()
  await done
})

test('a deleted Bot leaves the roster and the Main Bot list', async () => {
  const { actions, roster } = bench()
  void actions.deleteBot('main')
  const snapshot = roster.getSnapshot()
  assert.deepEqual(snapshot.bots.map(bot => bot.id), ['writer'])
  assert.equal(snapshot.byId.main, undefined)
  assert.deepEqual(snapshot.mainBotIds, [])
  assert.equal(snapshot.mainBotId, null)
})

test('deleting another Bot keeps the open panel', async () => {
  const { actions, ui } = bench()
  const done = actions.deleteBot('writer')
  assert.equal(ui.getSnapshot().details, 'room1')
  void done
})

test('a refused delete reads the team again so the row comes back', async () => {
  const { actions, refreshes } = bench({ refuse: true })
  await assert.rejects(actions.deleteRoom('room1'), /refused/)
  assert.equal(refreshes(), 1)
})
