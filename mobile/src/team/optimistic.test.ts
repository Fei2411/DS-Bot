import assert from 'node:assert/strict'
import { test } from 'node:test'
import { optimistic, withWrites } from './optimistic.ts'
import type { TeamState } from '../connection.ts'

const team: TeamState = {
  revision: 7,
  bots: [
    { id: 'b1', name: 'Chief', color: '#111111', effort: 'medium', workDir: '/work/a', capabilities: ['shell'] },
    { id: 'b2', name: 'Coder', capabilities: [] },
  ],
  rooms: [
    { id: 'r1', name: 'Standup', members: ['b1', 'b2'] },
    { id: 'r2', name: 'Quiet', members: ['b2'] },
  ],
  mainBotIds: ['b1'],
  mainBotId: 'b1',
}

test('update-bot shallow-merges the patch into that bot', () => {
  const next = optimistic(team, 'update-bot', { id: 'b1', color: '#abcdef', name: 'Boss' })!
  assert.equal(next.bots[0].color, '#abcdef')
  assert.equal(next.bots[0].name, 'Boss')
  assert.equal(next.bots[0].effort, 'medium')
  assert.equal(next.bots[1].name, 'Coder')
  assert.equal(team.bots[0].color, '#111111')
})

test('update-bot clears effort on null and workDir on empty', () => {
  const next = optimistic(team, 'update-bot', { id: 'b1', effort: null, workDir: '' })!
  assert.equal('effort' in next.bots[0], false)
  assert.equal('workDir' in next.bots[0], false)
})

test('update-bot replaces the whole avatar object', () => {
  const next = optimistic({ ...team, bots: [{ ...team.bots[0], avatar: { shape: 'star', image: 'data:x' } }, team.bots[1]] }, 'update-bot', { id: 'b1', avatar: { shape: 'moon' } })!
  assert.deepEqual(next.bots[0].avatar, { shape: 'moon' })
})

test('set-main adds and removes in mainBotIds and keeps mainBotId', () => {
  const added = optimistic(team, 'set-main', { id: 'b2', main: true })!
  assert.deepEqual(added.mainBotIds, ['b1', 'b2'])
  assert.equal(added.mainBotId, 'b1')
  const removed = optimistic(added, 'set-main', { id: 'b1', main: false })!
  assert.deepEqual(removed.mainBotIds, ['b2'])
  assert.equal(removed.mainBotId, 'b2')
  const none = optimistic(removed, 'set-main', { id: 'b2', main: false })!
  assert.deepEqual(none.mainBotIds, [])
  assert.equal(none.mainBotId, null)
})

test('bot-capability adds and removes the name in that bot', () => {
  const added = optimistic(team, 'bot-capability', { botId: 'b2', name: 'shell', attached: true })!
  assert.deepEqual(added.bots[1].capabilities, ['shell'])
  const removed = optimistic(team, 'bot-capability', { botId: 'b1', name: 'shell', attached: false })!
  assert.deepEqual(removed.bots[0].capabilities, [])
})

test('update-room shallow-merges the patch into that room', () => {
  const next = optimistic(team, 'update-room', { id: 'r1', name: 'Daily', notice: 'Bring updates' })!
  assert.equal(next.rooms![0].name, 'Daily')
  assert.equal(next.rooms![0].notice, 'Bring updates')
  assert.deepEqual(next.rooms![0].members, ['b1', 'b2'])
  assert.equal(next.rooms![1].name, 'Quiet')
})

test('unknown ids, unknown endpoints and an empty team change nothing', () => {
  assert.equal(optimistic(team, 'update-bot', { id: 'ghost', color: '#000000' }), team)
  assert.equal(optimistic(team, 'set-main', { id: 'ghost', main: true }), team)
  assert.equal(optimistic(team, 'bot-capability', { botId: 'ghost', name: 'shell', attached: true }), team)
  assert.equal(optimistic(team, 'update-room', { id: 'ghost', name: 'x' }), team)
  assert.equal(optimistic(team, 'delete-bot', { id: 'b1' }), team)
  assert.equal(optimistic(null, 'update-bot', { id: 'b1' }), null)
})

test('a stale read keeps the guess of a write still in flight', () => {
  const stale = { ...team, bots: [{ ...team.bots[0], permission: 'workspace-write' }, team.bots[1]] }
  const next = withWrites(stale, [{ endpoint: 'update-bot', payload: { id: 'b1', permission: 'read-only' } }])
  assert.equal(next.bots[0].permission, 'read-only')
  assert.equal(withWrites(stale, []), stale)
})
