// The team as the window keeps it: the Bot views' own sources and actions, fed by the
// engine's `state` endpoint and live feed. The views also read a few Session facts that
// DSH keeps for them in the plugin; here the window keeps those as well.
import { useRef, useSyncExternalStore } from 'react'
import { call } from '../../../ds-bot/src/client/api.js'
import { noticeApprovals } from '../../../ds-bot/src/client/approval-notices.js'
import { workPhrase } from '../../../ds-bot/src/client/cells.js'
import { language } from '../../../ds-bot/src/client/i18n.js'
import { toolState } from '../../../ds-bot/src/client/mark.js'
import { noteLeft, setUnread, sharedMap, toggleReaction } from '../../../ds-bot/src/client/shared-map.js'
import { createSource, EMPTY_ROSTER, indexRoster } from '../../../ds-bot/src/client/sources.js'
import { STORAGE, migrateStorage } from '../../../ds-bot/src/client/storage.js'
import { teamActions } from '../../../ds-bot/src/client/team-actions.js'
import { currentPart } from '../../../ds-bot/src/client/text.js'
import { registry } from '../../../ds-bot/src/client/themes.js'
import { openFeed } from './api.js'

// Memory news and connector states change without a notice on the feed.
const CATCH_UP_MS = 15_000
const READ_AGAIN = new Set(['hello', 'revision', 'live'])
const NO_WORK = { bots: {}, approvals: [] }

// A selection from a source. The value is kept per snapshot and selector, so React reads
// one value until the source changes.
function useSelect(source, selector) {
  const kept = useRef(null)
  const read = () => {
    const snapshot = source.getSnapshot()
    const last = kept.current
    if (last?.snapshot === snapshot && last.selector === selector) return last.value
    const value = selector(snapshot)
    kept.current = { snapshot, selector, value: last && Object.is(last.value, value) ? last.value : value }
    return kept.current.value
  }
  return useSyncExternalStore(source.subscribe, read)
}

function createBus() {
  const listeners = new Set()
  return {
    on(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    emit(event, data) { for (const listener of listeners) listener(event, data) },
  }
}

const setChanged = (source, value) => { if (JSON.stringify(source.getSnapshot()) !== JSON.stringify(value)) source.set(value) }

export function createTeam() {
  migrateStorage()
  const unreadStore = sharedMap(STORAGE.unread)
  const reactionStore = sharedMap(STORAGE.reactions)
  // When each conversation was last left; a visit compares new entries against it.
  const seenStore = sharedMap(STORAGE.seen)
  let seenAt = seenStore.read()
  const roster = createSource(EMPTY_ROSTER)
  const ui = createSource({ details: null, view: 'details', renaming: false, tab: null, newChat: null, exchange: null, menu: null, voice: null, palette: null, quote: null, settings: null, memory: null, toast: null, signIn: null, renameAgent: null, unread: unreadStore.read(), reactions: reactionStore.read(), visits: {} })
  const activity = createSource({})
  const work = createSource(NO_WORK)
  const memoryNews = createSource({})
  const live = createSource({})
  const cards = createSource({})
  const heldCards = createSource({})
  const turnClock = createSource({})
  const update = createSource({ available: false, phase: 'idle' })
  const computer = createSource({})
  const browserHolds = createSource({})
  const browserPages = createSource({})
  const browserTabs = createSource({})
  const layout = createSource({ wide: true })
  // The Session facts: the list (each one's latest entry and change, and which one fills
  // the main view), the status (running, a reply not yet seen) and what was just sent.
  const sessions = createSource({ ids: [], byId: {} })
  const status = createSource(new Map())
  const sent = createSource({})
  const shown = createSource(null)
  const chat = createBus()

  const editRow = (id, edit) => sessions.set((list) => {
    const row = list.byId[id] ?? { id }
    return { ids: list.ids.includes(id) ? list.ids : [...list.ids, id], byId: { ...list.byId, [id]: edit(row) } }
  })
  const setStatus = (id, patch) => status.set((map) => {
    const entry = map.get(id) ?? {}
    if (Object.entries(patch).every(([key, value]) => (entry[key] ?? false) === value)) return map
    return new Map(map).set(id, { ...entry, ...patch })
  })
  const show = (id) => {
    if (shown.getSnapshot() === id) return
    const before = shown.getSnapshot()
    shown.set(id)
    if (before) editRow(before, row => ({ ...row, retainedBy: { mainView: 0 } }))
    editRow(id, row => ({ ...row, retainedBy: { mainView: 1 } }))
    setStatus(id, { completionUnread: false })
  }

  let newsKey
  const noteNews = (next) => {
    const key = JSON.stringify(next)
    if (key === newsKey) return
    const opening = newsKey === undefined
    newsKey = key
    memoryNews.set(state => Object.fromEntries(Object.entries(next).map(([id, entry]) => [id,
      state[id]?.at === entry.at ? state[id] : { ...entry, seen: opening ? 0 : Date.now() }])))
  }
  const seenKey = id => roster.getSnapshot().byId?.[id]?.id ?? id
  const leaveVisits = (ids) => {
    seenAt = seenStore.update(seen => noteLeft(seen, ids.map(seenKey), Date.now()), seenAt)
  }
  const writeUnread = (id, value) => {
    const unread = unreadStore.update(marks => setUnread(marks, id, value), ui.getSnapshot().unread)
    ui.set(state => (JSON.stringify(state.unread) === JSON.stringify(unread) ? state : { ...state, unread }))
  }

  // Reads can overlap (the feed and a finished action); an older answer never wins.
  let pulls = 0
  let applied = 0
  let liveKey
  const pull = async () => {
    const order = ++pulls
    const known = roster.getSnapshot()
    const value = await call('state', { since: known.revision, models: known.modelsKey ?? '', live: liveKey, locale: language() })
    if (order < applied) return
    applied = order
    if (value.liveKey !== undefined) liveKey = value.liveKey
    if (value.activity !== undefined) setChanged(activity, value.activity)
    if (value.work !== undefined) setChanged(work, value.work)
    if (value.computerLive !== undefined) setChanged(computer, value.computerLive)
    if (value.browserHolds !== undefined) setChanged(browserHolds, value.browserHolds)
    if (value.memoryNews !== undefined) noteNews(value.memoryNews)
    const current = roster.getSnapshot()
    const changed = {}
    if (value.readOnly !== undefined && (value.readOnly ?? null) !== (current.readOnly ?? null)) changed.readOnly = value.readOnly
    if (value.connectors !== undefined && JSON.stringify(value.connectors) !== JSON.stringify(current.connectors ?? [])) changed.connectors = value.connectors
    if (value.capabilityStatuses !== undefined && JSON.stringify(value.capabilityStatuses) !== JSON.stringify(current.capabilityStatuses ?? {})) changed.capabilityStatuses = value.capabilityStatuses
    if (value.learning !== undefined && JSON.stringify(value.learning) !== JSON.stringify(current.learning ?? {})) changed.learning = value.learning
    if (value.learningSettled !== undefined && JSON.stringify(value.learningSettled) !== JSON.stringify(current.learningSettled ?? {})) changed.learningSettled = value.learningSettled
    if (value.btwCards !== undefined && JSON.stringify(value.btwCards) !== JSON.stringify(current.btwCards ?? {})) changed.btwCards = value.btwCards
    if (value.sideChats !== undefined && JSON.stringify(value.sideChats) !== JSON.stringify(current.sideChats ?? {})) changed.sideChats = value.sideChats
    if (value.phone !== undefined && JSON.stringify(value.phone) !== JSON.stringify(current.phone ?? null)) changed.phone = value.phone
    if (value.mcp !== undefined && JSON.stringify(value.mcp) !== JSON.stringify(current.mcp ?? null)) changed.mcp = value.mcp
    if (value.imStatus !== undefined && JSON.stringify(value.imStatus) !== JSON.stringify(current.imStatus ?? {})) changed.imStatus = value.imStatus
    if (value.imVia !== undefined && JSON.stringify(value.imVia) !== JSON.stringify(current.imVia ?? {})) changed.imVia = value.imVia
    if (value.secrets !== undefined && JSON.stringify(value.secrets) !== JSON.stringify(current.secrets ?? [])) changed.secrets = value.secrets
    if (value.secretStore !== undefined && JSON.stringify(value.secretStore) !== JSON.stringify(current.secretStore ?? {})) changed.secretStore = value.secretStore
    if (value.memoryReviews !== undefined && JSON.stringify(value.memoryReviews) !== JSON.stringify(current.memoryReviews ?? {})) changed.memoryReviews = value.memoryReviews
    if (Object.keys(changed).length > 0 && current.ready) roster.set({ ...current, ...changed })
    if (value.unchanged || (value.revision === current.revision && value.modelsKey === current.modelsKey)) return
    // In a window with no visit record yet, everything already there counts as seen.
    if (Object.keys(seenAt).length === 0) leaveVisits([...value.bots, ...value.rooms].map(entry => entry.id))
    const indexed = indexRoster(value)
    roster.set(indexed)
    // Follow a Bot or group chat onto its new segment when context rolls over or moves to background.
    const open = shown.getSnapshot()
    if (open) {
      const target = indexed.byId[open] ?? indexed.roomsById[open]
      const nextPart = target ? currentPart(target) : open
      if (nextPart && nextPart !== open) show(nextPart)
    }
  }
  const after = promise => promise.then(async (value) => { await pull().catch(() => {}); return value })
  const partFor = (id) => {
    const snap = roster.getSnapshot()
    const bot = snap.byId[id]
    if (bot) return currentPart(bot)
    const room = snap.roomsById[id]
    return room ? currentPart(room) : id
  }

  // Per-session turn facts (`{ turns: Map<turn, { turn, start, end? }>, openTurn }`) fed by
  // `SessionTranscript` so `BtwDock`, `BtwTurnTail`, `LearningDock`, and `LearningTurnTail`
  // place cards on closed turns and hold open-turn cards in the dock.
  const EMPTY_TURN_FACTS = Object.freeze({ turns: undefined, openTurn: undefined })
  const turnFactsBySession = new Map()
  const turnWatchers = new Map()
  const notifyTurnWatchers = (sessionId) => {
    const set = turnWatchers.get(sessionId)
    if (!set) return
    for (const listener of Array.from(set)) {
      try { listener() } catch { /* listener failure */ }
    }
  }

  const baseActions = teamActions({ call, after, partFor, roster, ui, live, cards, heldCards, turnClock })
  const clearShortcuts = () => ui.set(state => (state.shortcuts ? { ...state, shortcuts: false } : state))

  const actions = {
    ...baseActions,
    openSettings: (...args) => { clearShortcuts(); return baseActions.openSettings(...args) },
    openPalette: (...args) => { clearShortcuts(); return baseActions.openPalette(...args) },
    openGroupSearch: (...args) => { clearShortcuts(); return baseActions.openGroupSearch?.(...args) },
    openNewChat: (...args) => { clearShortcuts(); return baseActions.openNewChat(...args) },
    learningAnswer: (id, approve) => after(call('learning-answer', { id, approve })),
    // The full-pane overlays sit above the conversation, so opening one dismisses them.
    openSession: (id) => {
      ui.set(state => (state.newChat || state.exchange || state.menu || state.palette || state.shortcuts ? { ...state, newChat: null, exchange: null, menu: null, palette: null, shortcuts: false } : state))
      show(partFor(id))
    },
    landOn: id => show(partFor(id)),
    toggleSidebar: () => layout.set(state => ({ ...state, wide: !state.wide })),
    openShortcuts: () => ui.set(state => ({ ...state, shortcuts: true, menu: null, palette: null, groupSearch: null })),
    closeShortcuts: () => ui.set(state => (state.shortcuts ? { ...state, shortcuts: false } : state)),
    markUnread: id => writeUnread(id, true),
    clearUnread: id => writeUnread(id, false),
    beginVisit: (id) => {
      // A conversation a Bot started, never opened here, is unread from its start.
      const made = roster.getSnapshot().byId[id] ?? roster.getSnapshot().roomsById[id]
      const seen = seenAt[seenKey(id)] ?? (made?.createdBy && Number.isFinite(made.createdAt) ? made.createdAt : null)
      ui.set(state => ({ ...state, visits: { ...state.visits, [id]: { seen, entered: Date.now() } } }))
    },
    endVisit: (id) => {
      leaveVisits([id])
      ui.set((state) => {
        if (!(id in (state.visits ?? {}))) return state
        const visits = { ...state.visits }
        delete visits[id]
        return { ...state, visits }
      })
    },
    toggleReaction: (key, index, emoji) => {
      const reactions = reactionStore.update(saved => toggleReaction(saved, key, index, emoji), ui.getSnapshot().reactions)
      ui.set(state => ({ ...state, reactions }))
    },
    // The window has no DSH status bar, so the Bot's details show its figures.
    runStats: botId => call('run-stats', { botId }),
    // Nor DSH's settings: model providers and their keys have a Models page here, and a
    // first model choice takes a missing API key itself.
    providers: () => call('providers'),
    setProviderKey: (provider, value) => after(call('provider-key', { provider, value })),
    addProvider: body => after(call('provider-add', body)),
    providerModels: body => call('provider-models', body),
    removeProvider: provider => after(call('provider-remove', { provider })),
    openModels: () => actions.openSettings('models'),
    hasRightSidebar: () => false,
    canReferenceChat: () => true,
    referenceChat: (sessionId, insertion) => chat.emit('reference-chat', { sessionId, insertion }),
    speech: () => undefined,
    voiceSetup: () => null,
    noteTurnFacts: (sessionId, facts) => {
      if (!sessionId) return
      if (!facts) {
        if (!turnFactsBySession.has(sessionId)) return
        turnFactsBySession.delete(sessionId)
      } else {
        turnFactsBySession.set(sessionId, facts)
      }
      notifyTurnWatchers(sessionId)
    },
    turnFacts: sessionId => turnFactsBySession.get(sessionId) ?? EMPTY_TURN_FACTS,
    watchTurns: (sessionId, listener) => {
      if (!sessionId || typeof listener !== 'function') return () => {}
      let set = turnWatchers.get(sessionId)
      if (!set) { set = new Set(); turnWatchers.set(sessionId, set) }
      set.add(listener)
      return () => {
        set.delete(listener)
        if (set.size === 0) turnWatchers.delete(sessionId)
      }
    },
    noteSent: (sessionId) => {
      sent.set(state => ({ ...state, [sessionId]: [...(state[sessionId] ?? []), { placement: 'direct', time: Date.now() }] }))
    },
  }

  // Running and the tool at work come with the team's state; the plugin reads them from
  // DSH's Session status and its own tool cells.
  const followWork = () => {
    const snap = work.getSnapshot()
    const bots = snap.bots ?? {}
    const rooms = snap.rooms ?? {}
    const r = roster.getSnapshot()
    for (const bot of r.bots) {
      const part = currentPart(bot)
      const doing = bots[bot.id]?.roomId === undefined ? bots[bot.id] : undefined
      setStatus(part, { running: doing !== undefined })
      actions.noteLive(part, 'tool', doing?.tool ? { label: workPhrase(doing), state: toolState(doing.tool) } : null)
    }
    for (const room of r.rooms ?? []) {
      const part = currentPart(room)
      const busy = (rooms[room.id]?.length ?? 0) > 0
      setStatus(part, { running: busy })
    }
  }
  roster.subscribe(followWork)
  work.subscribe(followWork)

  const onFeed = (event, data) => {
    if (event === 'message' && data?.sessionId && data.item) {
      const { sessionId, item } = data
      const text = item.kind === 'bot' || item.kind === 'user' ? item.text : ''
      editRow(sessionId, row => ({
        ...row,
        updatedAt: Math.max(row.updatedAt ?? 0, item.time ?? 0),
        // The sidebar's preview line; turn -1 is never a hidden exchange turn.
        projectionValues: text ? { turnOutline: [{ turn: -1, [item.kind === 'bot' ? 'response' : 'prompt']: text }] } : row.projectionValues,
      }))
      if (item.kind === 'bot' && shown.getSnapshot() !== sessionId) setStatus(sessionId, { completionUnread: true })
      if (item.kind === 'user') sent.set(state => (state[sessionId]?.length ? { ...state, [sessionId]: state[sessionId].slice(1) } : state))
    }
    // While a reply streams in, it stands in for the activity row.
    if (event === 'stream' && data?.sessionId) actions.noteLive(data.sessionId, 'reply', data.phase === undefined && data.text ? { text: true } : null)
    chat.emit(event, data)
  }

  const start = () => {
    let stopped = false
    const read = () => {
      void pull().catch((error) => {
        if (stopped) return
        console.warn('[ds-bot] state', error)
        if (!roster.getSnapshot().ready) actions.reportError(error, 'state')
      })
    }
    read()
    const closeFeed = openFeed((event, data) => {
      if (READ_AGAIN.has(event)) read()
      onFeed(event, data)
    })
    const stopApprovalNotices = noticeApprovals({
      work,
      roster,
      shownSession: () => shown.getSnapshot(),
      openSession: actions.openSession,
    })
    const timer = setInterval(read, CATCH_UP_MS)
    const onPageHide = () => leaveVisits(Object.keys(ui.getSnapshot().visits ?? {}))
    window.addEventListener('pagehide', onPageHide)
    return () => {
      stopped = true
      closeFeed()
      stopApprovalNotices()
      clearInterval(timer)
      window.removeEventListener('pagehide', onPageHide)
    }
  }

  const use = source => selector => useSelect(source, selector)
  const hooks = {
    useRoster: use(roster),
    useUi: use(ui),
    useActivity: use(activity),
    useWork: use(work),
    useMemoryNews: use(memoryNews),
    useLive: use(live),
    useCards: use(cards),
    useHeldCards: use(heldCards),
    useTurnClock: use(turnClock),
    useUpdate: use(update),
    useRegistry: use(registry),
    useComputer: use(computer),
    useBrowserHolds: use(browserHolds),
    useBrowserPages: use(browserPages),
    useBrowserTabs: use(browserTabs),
    useSessions: use(sessions),
    useSessionStatus: use(status),
    useSessionRetainInfo: (id, selector) => useSelect(sessions, list => selector(list.byId[id])),
    useLayout: use(layout),
    useShown: use(shown),
  }
  // The Session one view shows, as DSH hands it to a view: what was just sent there.
  const sessionHook = sessionId => selector => useSelect(sent, state => selector({ pendingSubmissions: state[sessionId] ?? [] }))
  return { actions, hooks, sessionHook, chat, start }
}
