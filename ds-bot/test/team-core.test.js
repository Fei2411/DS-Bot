import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assembleTeamActions,
  clearFailedSends,
  createBrowserController,
  createDraftFiles,
  createFeedController,
  createNavigationActions,
  createSessionStore,
  createStoreActions,
  createTeamPull,
  createTeamStore,
  createUpdateController,
  diffLiveRosterFields,
  hasPendingFailedAttachments,
  indexRoster,
  partForRoster,
  pendingFailedByChat,
  pruneRemovedChatDrafts,
  seenKeyOf,
  SETTINGS_PANEL_IDS,
  startComputerBridge,
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

test('team-core drafts manage draft files, failed-send reload guard, and removed chat pruning', () => {
  clearFailedSends()
  const pool = createDraftFiles()
  const img = { name: 'shot.png', size: 12, type: 'image/png' }
  const doc = { name: 'notes.txt', size: 4, type: 'text/plain' }
  const ids = pool.restoreDraftFiles('bot-a', [img, { kind: 'file', file: doc }, null, {}])
  assert.equal(ids.length, 2)
  assert.deepEqual(pool.draftFiles(ids), [
    { kind: 'image', file: img },
    { kind: 'file', file: doc },
  ])
  pool.pruneBySessions(sid => sid !== 'bot-a')
  assert.deepEqual(pool.draftFiles(ids), [])

  const storage = makeStorage({ 'ds-bot:drafts': JSON.stringify({ 'bot-a': 'hello', 'bot-b': 'keep' }) })
  const prunedChats = []
  const questionDrafts = { pruneChats: chats => prunedChats.push(...chats) }
  pendingFailedByChat.set('bot-a', [{ text: 'failed', items: [{ previewUrl: 'blob:a' }] }])
  assert.equal(hasPendingFailedAttachments(), true)
  pruneRemovedChatDrafts(['bot-a'], questionDrafts, { storage })
  assert.deepEqual(prunedChats, ['bot-a'])
  assert.equal(hasPendingFailedAttachments(), false)
  assert.deepEqual(JSON.parse(storage.getItem('ds-bot:drafts')), { 'bot-b': 'keep' })
})

test('team-core navigation actions serialize recoverOpening and landOn across async pulls', async () => {
  const storage = makeStorage()
  const store = createTeamStore({ storage })
  store.roster.set(indexRoster({
    revision: 1,
    bots: [{ id: 'bot-a', sessionId: 'bot-a-p1', parts: ['bot-a-p1'] }],
    rooms: [],
  }))
  const landed = []
  const recovered = []
  const retried = []
  const pullDeferred = Promise.withResolvers()
  const nav = createNavigationActions({
    call: async (name) => {
      if (name === 'recover-session') {
        store.roster.set(indexRoster({
          revision: 2,
          bots: [{ id: 'bot-a', sessionId: 'bot-a-p2', parts: ['bot-a-p1', 'bot-a-p2'] }],
          rooms: [],
        }))
      }
      return {}
    },
    after: p => p,
    pull: async () => {
      await pullDeferred.promise
      store.roster.set(indexRoster({
        revision: 3,
        bots: [{ id: 'bot-a', sessionId: 'bot-a-p3', parts: ['bot-a-p1', 'bot-a-p2', 'bot-a-p3'] }],
        rooms: [],
      }))
    },
    store,
    onRetry: target => retried.push(target),
    onRecovered: sid => recovered.push(sid),
    onLand: target => landed.push(target),
  })

  nav.actions.retryOpening('bot-a-p1')
  assert.deepEqual(retried, ['bot-a-p1'])

  await nav.actions.recoverOpening('bot-a')
  assert.deepEqual(recovered, ['bot-a-p2'])

  // Stale expectedSeq does not land.
  nav.actions.landOn('bot-a', null, nav.actions.navSeq() - 1)
  assert.deepEqual(landed, [])

  // Async landOn waits for pull, then lands on the new part unless superseded.
  const pendingLand = nav.actions.landOn('bot-a', { kind: 'bot', botId: 'bot-a', sessionId: 'bot-a-p2' })
  pullDeferred.resolve()
  await pendingLand
  assert.deepEqual(landed, ['bot-a-p3'])
})

test('team-core update controller merges plugin, DSH, and ownApp updates without duplicate check calls', async () => {
  const storage = makeStorage()
  const store = createTeamStore({ storage })
  const calls = []
  let ownListener = null
  const ctrl = createUpdateController({
    call: async (name, body) => {
      calls.push([name, body])
      if (name === 'update-check') return { phase: 'available', latest: '0.4.3', current: '0.4.2' }
      if (name === 'update-install') return { phase: 'installing' }
      if (name === 'dsh-update-install') return { phase: 'installing', latest: '1.2.0' }
      return {}
    },
    update: store.update,
    getAppUpdates: () => null,
    getOwnAppUpdates: () => ({
      state: async () => ({ phase: 'idle', version: '0.4.2' }),
      subscribe: (fn) => { ownListener = fn; return () => { ownListener = null } },
      check: async () => { calls.push(['own-check']) },
    }),
  })
  const stop = ctrl.start()
  try {
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(store.update.getSnapshot().latest, '0.4.3')
    assert.equal(store.update.getSnapshot().ownApp.version, '0.4.2')

    const countBefore = calls.filter(([n]) => n === 'update-check').length
    await ctrl.actions.checkUpdate()
    const countAfter = calls.filter(([n]) => n === 'update-check').length
    // Fresh checkUpdate must NOT trigger a second immediate update-check.
    assert.equal(countAfter - countBefore, 1)

    ownListener?.({ phase: 'available', version: '0.4.3' })
    assert.equal(store.update.getSnapshot().ownApp.phase, 'available')
    await ctrl.actions.checkOwnApp()
    assert.equal(calls.some(([n]) => n === 'own-check'), true)
  } finally {
    stop()
  }
})

test('team-core browser and computer controllers manage tabs, retains, cursor abort, and store actions', async () => {
  const storage = makeStorage()
  const store = createTeamStore({ storage })
  store.roster.set({
    ...indexRoster({
      revision: 1,
      browser: true,
      computer: { enabled: true },
      bots: [{ id: 'bot-a', name: 'Alpha', sessionId: 'bot-a', parts: ['bot-a'] }],
      rooms: [],
    }),
    ready: true,
  })
  const storeActions = createStoreActions({ store, clearPanelYieldOnToggle: true })
  store.setPanelYield(true)
  storeActions.toggleLeftHidden()
  assert.equal(store.ui.getSnapshot().panelYield, false)

  const forgotten = []
  const bridge = {
    acquire: async key => ({ partition: `persist:${key}` }),
    forget: async key => { forgotten.push(key) },
    views: { hold: async () => {}, subscribe: () => () => {}, place: async () => {} },
  }
  const browser = createBrowserController({
    call: (name, _body, signal) => {
      if (name === 'browser-wait') {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
      }
      return Promise.resolve({})
    },
    store,
    bridge,
    onClosePanel: () => store.ui.set(s => ({ ...s, details: null })),
  })
  const stopBrowser = browser.start()
  try {
    browser.actions.openBrowser('bot-a')
    assert.equal(store.ui.getSnapshot().view, 'browser')
    assert.equal(store.ui.getSnapshot().details, 'bot-a')
    assert.equal(browser.browserTabs.getSnapshot()['bot-a']?.ids?.length, 1)

    // Removing bot-a reconciles browser panel back to details and forgets its partition.
    store.roster.set({
      ...indexRoster({ revision: 2, browser: true, computer: { enabled: true }, bots: [], rooms: [] }),
      ready: true,
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(store.ui.getSnapshot().view, 'details')
    assert.deepEqual(forgotten, ['bot:bot-a'])
  } finally {
    stopBrowser()
  }

  let cursorAborted = false
  const computerRows = []
  const stops = []
  const stopComputer = startComputerBridge({
    call: (name, _body, signal) => {
      if (name === 'computer-cursor-wait') {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => { cursorAborted = true; reject(new Error('aborted')) })
        })
      }
      return Promise.resolve({})
    },
    store,
    onStop: (botId, all) => stops.push([botId, all]),
    appComputer: {
      computer: payload => computerRows.push(payload),
      computerCursor: () => {},
      onComputerAction: (cb) => { cb({ kind: 'stop', botId: 'bot-a' }); return () => {} },
    },
  })
  store.computer.set({ leases: [{ botId: 'bot-a', kind: 'foreground', appName: 'Safari' }], bots: {} })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(computerRows.at(-1)?.rows?.length, 1)
  assert.deepEqual(stops, [['bot-a', false]])
  stopComputer()
  assert.equal(cursorAborted, true)
})

test('team-core assembleTeamActions orchestrates openChanges, steerQueued, openSession, and host hooks uniformly', async () => {
  const storage = makeStorage()
  const store = createTeamStore({ storage })
  store.roster.set(indexRoster({
    revision: 1,
    bots: [{ id: 'bot-a', sessionId: 'bot-a-p2', parts: ['bot-a', 'bot-a-p2'] }],
    rooms: [],
    agents: [{ id: 'agent-1', sessions: ['cs-1'] }],
  }))
  const openedTeam = []
  const openedAgent = []
  const openedChanges = []
  let closedPanelCount = 0
  let fallbackSteerCalls = 0
  const nav = createNavigationActions({
    call: async () => ({}),
    after: p => p,
    pull: async () => false,
    store,
    onRetry: () => {},
    onRecovered: () => {},
    onLand: () => {},
  })
  const updateCtrl = createUpdateController({ call: async () => ({}), update: store.update, getAppUpdates: () => null, getOwnAppUpdates: () => null })
  const browserCtrl = createBrowserController({ call: async () => ({}), store, bridge: null })
  const actions = assembleTeamActions({
    call: async (endpoint, body) => {
      if (endpoint === 'changes-check') return body.seq === 5
      if (endpoint === 'bot-steer-queue') return body.ids.includes('q-fallback') ? { fallback: true } : { ok: true }
      return {}
    },
    after: p => p,
    store,
    foldWrites: sectionFoldWrites(),
    panelFolded: () => false,
    nav,
    updateCtrl,
    browserCtrl,
    host: {
      afterClosePanel: () => { closedPanelCount += 1 },
      openChanges: changes => openedChanges.push(changes),
      isAgentSession: id => id === 'cs-1',
      openTeamSession: args => openedTeam.push(args),
      openAgentSession: sid => openedAgent.push(sid),
      steerQueued: async (sid, { tryBotBatch }) => {
        const res = await tryBotBatch(sid === 'bot-a-p2' ? ['q-fallback'] : ['q-1'])
        if (res === 'fallback') fallbackSteerCalls += 1
      },
    },
  })

  // openSession routes agent sessions to openAgentSession and bots to openTeamSession with partFor resolution.
  actions.openSession('cs-1')
  assert.deepEqual(openedAgent, ['cs-1'])
  actions.openSession('bot-a')
  assert.equal(openedTeam.length, 1)
  assert.equal(openedTeam[0].target, 'bot-a-p2')

  // openChanges checks availability via host and notices when unavailable.
  await actions.openChanges({ sessionId: 'bot-a-p2', seq: 5, turn: 1 })
  assert.equal(openedChanges.length, 1)
  await actions.openChanges({ sessionId: 'bot-a-p2', seq: 99, turn: 1 })
  assert.equal(openedChanges.length, 1)
  assert.ok(store.ui.getSnapshot().toast?.text)

  // steerQueued delegates bot batch and falls back when host signals fallback: true.
  await actions.steerQueued('bot-a-p2')
  assert.equal(fallbackSteerCalls, 1)

  // closePanel triggers host cleanup hook; defaults for holdSettingsLook & SETTINGS_PANEL_IDS work.
  actions.closePanel()
  assert.equal(closedPanelCount, 1)
  assert.equal(typeof actions.holdSettingsLook(), 'function')
  assert.equal(SETTINGS_PANEL_IDS.has('models'), true)
})
