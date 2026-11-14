import assert from 'node:assert/strict'
import { test } from 'node:test'
import { atSources, chatRows } from '../src/client/at-menu.js'
import { indexRoster } from '../src/client/sources.js'

const roster = indexRoster({
  bots: [
    { id: 'chief', name: 'Chief', role: 'Lead', sessionId: 'chief-2', parts: ['chief'] },
    { id: 'king', name: 'King', sessionId: 'king' },
    { id: 'writer', name: 'Writer', sessionId: 'writer' },
    { id: 'reporter', name: '项目周报机器人', sessionId: 'reporter' },
  ],
  rooms: [],
})

const rows = []
for (let i = 1; i <= 12; i++) {
  rows.push({ id: 'session-' + i, displayTitle: '历史会话 ' + i, title: '历史会话 ' + i, updatedAt: i })
}
rows[2] = { id: 'session-3', displayTitle: '项目周报 讨论', title: '历史会话 3', updatedAt: 3 }
const list = { byId: Object.fromEntries(rows.map(r => [r.id, r])), ids: rows.map(r => r.id) }

test('an empty query keeps the other Bots and the latest eight Sessions', () => {
  const out = chatRows(roster, list, 'chief-2', '')
  assert.equal(out.length, 11) // 3 other Bots + 8
  assert.equal(out.filter(r => r.bot).length, 3)
  assert.equal(out.filter(r => r.sessionId.startsWith('session-')).length, 8)
})

test('a query matches Bots by their name and a conversation by its title', () => {
  // '项目周报' hits both the Bot's name and the session titled '项目周报 讨论';
  // the Bot rows come first, then the conversation rows.
  assert.deepEqual(chatRows(roster, list, 'chief-2', '项目周报').map(r => r.sessionId), ['reporter', 'session-3'])
  // A Bot's id is not searchable — only its name and its localized label are.
  assert.deepEqual(chatRows(roster, list, 'chief-2', 'reporter'), [])
  assert.deepEqual(chatRows(roster, list, 'chief-2', ' KING ').map(r => r.sessionId), ['king'])
})

test('a query matches a conversation by displayTitle, title or session id', () => {
  assert.deepEqual(chatRows(roster, list, 'king', '项目周报 讨论').map(r => r.sessionId), ['session-3'])
  assert.deepEqual(chatRows(roster, list, 'king', 'session-11').map(r => r.sessionId), ['session-11'])
})

test('an empty match list is empty, never the unfiltered list', () => {
  assert.deepEqual(chatRows(roster, list, 'chief-2', '不存在的xyz'), [])
})

test('a query widens the eight-Session cap', () => {
  const out = chatRows(roster, list, 'chief-2', '历史会话')
  assert.equal(out.length, 12) // 12 sessions match, more than the 8 the empty query sees
})

test('the chats source passes the query down and returns an empty list outside the team', async () => {
  let open = false
  const [, chats] = atSources({
    roster: { getSnapshot: () => roster },
    sessions: { list: { getSnapshot: () => list } },
    launched: () => open,
    iconFor: () => 'session',
  })
  assert.deepEqual(await chats.candidates({ sessionId: 'chief-2' }, { query: 'x' }), [])
  open = true
  const found = await chats.candidates({ sessionId: 'chief-2' }, { query: '项目周报' })
  assert.deepEqual(found.map(r => r.name), ['项目周报机器人', '项目周报 讨论'])
  assert.deepEqual(await chats.candidates({ sessionId: 'chief-2' }, { query: 'zzz' }), [])
  assert.deepEqual(await chats.candidates({ sessionId: 'plain' }, { query: '' }), [])
})
