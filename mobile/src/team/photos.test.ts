import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TeamState } from '../connection.ts'
import { fillTeamPhotos } from './photos.ts'

const team: TeamState = { revision: 1, bots: [{ id: 'chief', name: 'Chief', avatar: { imageRef: 'bot-ref' } }], rooms: [{ id: 'room', name: 'Team', avatar: { imageRef: 'room-ref' } }] }

test('mobile hydrates Bot and group photos from their content refs', () => {
  const next = fillTeamPhotos(team, null, new Map([['bot-ref', 'bot-image'], ['room-ref', 'room-image']]), () => { assert.fail('cached photo was fetched') })
  assert.equal(next.bots[0].avatar?.image, 'bot-image')
  assert.equal(next.rooms![0].avatar?.image, 'room-image')
  assert.equal(team.rooms![0].avatar?.image, undefined)
})

test('new group refs fetch the room endpoint target and keep the old photo until ready', () => {
  const fetches: unknown[] = []
  const prev: TeamState = { ...team, rooms: [{ ...team.rooms![0], avatar: { image: 'old-image' } }] }
  const next = fillTeamPhotos(team, prev, new Map(), (...args) => { fetches.push(args) })
  assert.deepEqual(fetches, [['chief', 'bot-ref', false], ['room', 'room-ref', true]])
  assert.equal(next.rooms![0].avatar?.image, 'old-image')
  const cleared = { ...team, rooms: [{ id: 'room', name: 'Team' }] }
  assert.equal(fillTeamPhotos(cleared, prev, new Map(), () => {}).rooms![0].avatar, undefined)
})

test('teams without group photos or rooms keep the same state object', () => {
  const plain = { revision: 0, bots: [{ id: 'chief', name: 'Chief' }] }
  assert.equal(fillTeamPhotos(plain, null, new Map(), () => {}), plain)
})
