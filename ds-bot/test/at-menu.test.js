import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatSessionReferenceMention, parseSessionReferenceText } from '@deepseek-ai/dsh-session-reference'
import { BOTS_SOURCE, CHATS_SOURCE, atSources, chatRows, mentionRows, sessionMention } from '../src/client/at-menu.js'
import { indexRoster } from '../src/client/sources.js'

const roster = indexRoster({
  bots: [
    { id: 'chief', name: 'Chief', role: 'Lead', sessionId: 'chief-2', parts: ['chief'] },
    { id: 'king', name: 'King', sessionId: 'king' },
    { id: 'writer', name: 'Writer', sessionId: 'writer' },
  ],
  rooms: [{ id: 'room', name: 'Launch', members: ['chief', 'king'], parts: ['king-in-room'] }],
})
const names = rows => rows.map(row => row.bot?.name ?? 'everyone')

test('a session mention is the one DSH writes and reads back', () => {
  for (const [id, label] of [['s-1', 'Chat with King'], ['会话/ä"x', 'a ] b \\ c'], ['', '']]) {
    const mention = sessionMention(id, label)
    assert.equal(mention, formatSessionReferenceMention({ sessionId: id, label }))
    assert.deepEqual(parseSessionReferenceText(`see ${mention}`), { text: `see @${label}`, references: [{ sessionId: id, label }] })
  }
})

test('"@" offers a group\'s members and everyone, or every other Bot in a Bot\'s chat', () => {
  assert.deepEqual(names(mentionRows(roster, 'room')), ['Chief', 'King', 'everyone'])
  assert.deepEqual(names(mentionRows(roster, 'chief-2')), ['King', 'Writer'])
  assert.deepEqual(names(mentionRows(roster, 'chief', 'wri')), ['Writer'])
  assert.deepEqual(names(mentionRows(roster, 'room', 'ev')), ['everyone'])
  assert.deepEqual(mentionRows(roster, 'room', 'k').map(row => row.text), ['@King '])
  assert.equal(mentionRows(roster, 'plain'), null)
  assert.equal(mentionRows(indexRoster({ bots: [], rooms: [] }), 'room'), null)
})

test('the chats are the other Bots\' current parts, then the latest Sessions outside the team', () => {
  const list = {
    ids: ['chief', 'chief-2', 'king', 'writer', 'room', 'king-in-room', 'old', 'new', 'child', 'blank'],
    byId: {
      king: { id: 'king', updatedAt: 5 },
      old: { id: 'old', displayTitle: 'Old work', updatedAt: 1 },
      new: { id: 'new', displayTitle: 'New work', updatedAt: 9 },
      child: { id: 'child', displayTitle: 'Child', origin: 'subagent', updatedAt: 10 },
      blank: { id: 'blank', displayTitle: 'Blank', blank: true, updatedAt: 11 },
    },
  }
  assert.deepEqual(chatRows(roster, list, 'chief-2').map(row => [row.sessionId, row.label]), [
    ['king', 'Chat with King'], ['writer', 'Chat with Writer'], ['new', 'New work'], ['old', 'Old work'],
  ])
  assert.deepEqual(chatRows(roster, list, 'room').map(row => row.sessionId), ['chief-2', 'king', 'writer', 'new', 'old'])
  assert.deepEqual(chatRows(roster, list, 'new'), [])
})

test('the chats join only the menu that "+" opened, and a pick inserts a session reference', async () => {
  let open = false
  const [bots, chats] = atSources({
    roster: { getSnapshot: () => roster },
    sessions: { list: { getSnapshot: () => ({ ids: [], byId: {} }) } },
    launched: () => open,
    iconFor: () => 'session',
  })
  assert.deepEqual([bots.name, chats.name], [BOTS_SOURCE, CHATS_SOURCE])
  assert.ok(bots.order < chats.order && chats.order < 0)
  const session = { sessionId: 'chief-2' }
  assert.deepEqual(await chats.candidates(session, { query: '' }), [])
  open = true
  const rows = await chats.candidates(session, { query: '' })
  assert.deepEqual(rows.map(row => row.name), ['King', 'Writer'])
  const picked = chats.onPick({ candidate: rows[0] })
  assert.deepEqual(picked.insert, {
    source: CHATS_SOURCE, ref: sessionMention('king', 'Chat with King'), label: 'Chat with King', appearance: 'session', clipboardText: sessionMention('king', 'Chat with King'),
  })
  assert.equal(await chats.codec.serialize(picked.insert.ref), picked.insert.ref)

  const mentions = await bots.candidates({ sessionId: 'room' }, { query: '' })
  assert.deepEqual(mentions.map(row => [row.name, row.description]), [['Chief', 'Lead'], ['King', undefined], ['Everyone', '2 members']])
  assert.deepEqual(bots.onPick({ candidate: mentions[1] }), { text: '@King ' })
  assert.deepEqual(await bots.candidates({ sessionId: 'plain' }, { query: '' }), [])
})
