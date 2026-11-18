import test from 'node:test'
import assert from 'node:assert/strict'
import { ownerOfSession } from '../src/host/session-identity.js'

const fixture = () => ({
  chatOwners: new Map([['current', 'a']]),
  groupOwners: new Map([['group', { botId: 'a', roomId: 'r' }]]),
  roomOwners: new Map([['room', 'r']]),
  pastOwners: new Map([['old', { botId: 'a' }], ['old-group', { botId: 'a', roomId: 'r' }]]),
  botOf: id => id === 'a' ? { id } : undefined,
})

test('identity follows current, archived and group sessions, not room roots', () => {
  const rt = fixture()
  assert.deepEqual(ownerOfSession(rt, 'current'), { botId: 'a' })
  assert.deepEqual(ownerOfSession(rt, 'old'), { botId: 'a' })
  assert.deepEqual(ownerOfSession(rt, 'group'), { botId: 'a', roomId: 'r' })
  assert.deepEqual(ownerOfSession(rt, 'old-group'), { botId: 'a', roomId: 'r' })
  for (const id of ['room', 'unknown', undefined, '', '__proto__']) assert.equal(ownerOfSession(rt, id), undefined)
  rt.chatOwners.delete('current')
  rt.pastOwners.set('current', { botId: 'a' })
  rt.chatOwners.set('next', 'a')
  assert.deepEqual(ownerOfSession(rt, 'current'), ownerOfSession(rt, 'next'))
})

test('identity fails closed for conflicting or deleted ownership', () => {
  const rt = fixture()
  rt.groupOwners.set('current', { botId: 'a', roomId: 'r' })
  assert.equal(ownerOfSession(rt, 'current'), undefined)
  rt.chatOwners.set('deleted', 'gone')
  assert.equal(ownerOfSession(rt, 'deleted'), undefined)
  rt.roomOwners.set('old', 'r')
  assert.equal(ownerOfSession(rt, 'old'), undefined)
})
