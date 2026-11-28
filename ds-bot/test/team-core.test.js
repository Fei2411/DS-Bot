import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createFeedController,
  createSessionStore,
  createTeamPull,
  createTeamStore,
  diffLiveRosterFields,
  indexRoster,
  partForRoster,
  seenKeyOf,
} from '../src/client/team-core/index.js'
import { sectionFoldWrites } from '../src/client/team-actions.js'

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    map,
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) },
    removeItem: k => { map.delete(k) },
  }
}

test('team-core roster helpers resolve multi-part bots, rooms, and seenKey consistently', () => {
  const indexed = indexRoster({
    revision: 2,
    bots: [{ id: 'bot-a', sessionId: 'bot-a-p2', parts: ['bot-a', 'bot-a-p2'] }],
    rooms: [{ id: 'room-1', sessionId: 'room-1-p2', ownParts: ['room-1', 'room-1-p2'] }],
    agents: [{ id: 'agent-1', sessions: ['cs-1'] }],
  })
  assert.equal(partForRoster(indexed, 'bot-a'), 'bot-a-p2')
  assert.equal(partForRoster(indexed, 'bot-a-p2'), 'bot-a-p2')
  assert.equal(partForRoster(indexed, 'room-1'), 'room-1-p2')
  assert.equal(partForRoster(indexed, 'room-1-p2'), 'room-1-p2')
  assert.equal(partForRoster(indexed, 'unknown'), 'unknown')
  // Group room segments resolve to the stable room id for visit tracking.
  assert.equal(seenKeyOf(indexed, 'bot-a-p2'), 'bot-a')
  assert.equal(seenKeyOf(indexed, 'room-1-p2'), 'room-1')
})

test('team-core pull serializes out-of-order replies, short-circuits unchanged liveKey, and notifies removed chats', async () => {
  const storage = makeStorage()
  const store = createTeamStore({ storage })
  const removedLog = []
  const hydratedLog = []
  const foldWrites = sectionFoldWrites()

  const p1 = Promise.withResolvers()
  const p2 = Promise.withResolvers()
  let callCount = 0
  const call = async (endpoint) => {
    if (endpoint !== 'state') return {}
    callCount += 1
    if (callCount === 1) return p1.promise
    if (callCount === 2) return p2.promise
    if (callCount === 3) {
      return { revision: 2, unchanged: true, liveKey: 'lk-2', connectors: [{ id: 'c1' }] }
    }
    return {
      revision: 3,
      modelsKey: 'm1',
      liveKey: 'lk-3',
      bots: [{ id: 'bot-a', sessionId: 'bot-a', parts: ['bot-a'] }],
      rooms: [],
      agents: [],
      sections: [],
      prefs: { theme: 'ember' },
    }
  }
  const { pull } = createTeamPull({
    call,
    store,
    foldWrites,
    storage,
    onChatsRemoved: gone => removedLog.push(gone),
    onHydrated: indexed => hydratedLog.push(indexed.revision),
  })

  const first = pull()
  const second = pull()
  p2.resolve({
    revision: 2,
    modelsKey: 'm1',
    liveKey: 'lk-2',
    bots: [
      { id: 'bot-a', sessionId: 'bot-a', parts: ['bot-a'] },
      { id: 'bot-b', sessionId: 'bot-b', parts: ['bot-b'] },
    ],
    rooms: [],
    agents: [],
    sections: [],
    connectors: [{ id: 'c1' }],
    prefs: { theme: 'deepseek' },
  })
  assert.equal(await second, true)
  p1.resolve({ revision: 1, modelsKey: 'm1', liveKey: 'lk-1', bots: [], rooms: [] })
  assert.equal(await first, false)
  assert.equal(store.roster.getSnapshot().revision, 2)

  // Same liveKey + unchanged revision returns false without touching roster.
  const beforeSnap = store.roster.getSnapshot()
  assert.equal(await pull(), false)
  assert.equal(store.roster.getSnapshot(), beforeSnap)

  // Revision 3 removes bot-b and persists prefs.
  assert.equal(await pull(), true)
  assert.deepEqual(removedLog, [['bot-b']])
  assert.deepEqual(hydratedLog, [2, 3])
  assert.equal(JSON.parse(storage.getItem('ds-bot:prefs')).theme, 'ember')

  // diffLiveRosterFields detects boolean, nullable, and JSON live fields including speech & memoryReviews.
  const diff = diffLiveRosterFields(
    { readOnly: 'locked', speech: true, memoryReviews: { 'bot-a': { status: 'pending' } } },
    { readOnly: null, speech: false, memoryReviews: {} },
  )
  assert.deepEqual(diff, {
    readOnly: 'locked',
    speech: true,
    memoryReviews: { 'bot-a': { status: 'pending' } },
  })
})

test('team-core session store and feed controller deduplicate replays and manage reconnect state', async () => {
  const storage = makeStorage()
  const store = createTeamStore({ storage })
  store.roster.set(indexRoster({
    revision: 1,
    bots: [
      { id: 'b1', sessionId: 'b1', parts: ['b1'] },
      { id: 'b2', sessionId: 'b2', parts: ['b2'] },
    ],
    rooms: [{ id: 'r1', sessionId: 'r1', ownParts: ['r1'] }],
  }))
  const liveEvents = []
  const sessionStore = createSessionStore({
    store,
    onNoteLive: (sid, kind, val) => liveEvents.push([sid, kind, val]),
  })
  let feedCb = null
  let readCalls = 0
  const feed = createFeedController({
    store,
    sessionStore,
    openFeed: (cb) => { feedCb = cb; return () => {} },
    read: () => { readCalls += 1 },
    onNoteLive: (sid, kind, val) => liveEvents.push([sid, kind, val]),
    reconnectNoticeMs: 20,
  })
  const stop = feed.start()
  try {
    sessionStore.show('b1')
    feedCb('hello', { revision: 1, resumed: true })
    assert.equal(readCalls, 0)
    feedCb('hello', { revision: 1, resumed: false })
    assert.equal(readCalls, 1)

    // Background reply counts once even if replayed on resumed reconnect.
    feedCb('message', { sessionId: 'b2', item: { kind: 'bot', text: 'hi', seq: 10, block: 0, turn: 0, time: 100 } })
    feedCb('message', { sessionId: 'b2', item: { kind: 'bot', text: 'hi', seq: 10, block: 0, turn: 0, time: 100 } })
    assert.equal(sessionStore.sessions.getSnapshot().byId.b2?.replyCount, 1)
    assert.equal(sessionStore.closingReply('b2', 0), 'hi')

    // Stream emits noteLive only on start/end transitions.
    feedCb('stream', { sessionId: 'b1', text: 'a' })
    feedCb('stream', { sessionId: 'b1', text: 'b' })
    feedCb('stream', { sessionId: 'b1', phase: 'end' })
    assert.deepEqual(liveEvents, [['b1', 'reply', { text: true }], ['b1', 'reply', null]])

    // Disconnect notice appears after reconnectNoticeMs and clears on hello.
    feedCb('lost', {})
    assert.equal(sessionStore.connection.getSnapshot().status, 'connected')
    await new Promise(resolve => setTimeout(resolve, 35))
    assert.equal(sessionStore.connection.getSnapshot().status, 'reconnecting')
    feedCb('hello', { revision: 1, resumed: true })
    assert.equal(sessionStore.connection.getSnapshot().status, 'connected')
  } finally {
    stop()
  }
})
