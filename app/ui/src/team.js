// The team as the window keeps it: the Bot views' own sources and actions, fed by the
// engine's `state` endpoint and live feed. The views also read a few Session facts that
// DSH keeps for them in the plugin; here the window keeps those as well.
import { useRef, useSyncExternalStore } from 'react'
import { call } from '../../../ds-bot/src/client/api.js'
import { noticeApprovals } from '../../../ds-bot/src/client/approval-notices.js'
import { createBotBrowsers, serveBrowserReads } from '../../../ds-bot/src/client/bot-browsers.js'
import { workPhrase } from '../../../ds-bot/src/client/cells.js'
import { language, t } from '../../../ds-bot/src/client/i18n.js'
import { lookOf, toolState } from '../../../ds-bot/src/client/mark.js'
import { needsIdleSample } from '../../../ds-bot/src/client/polling.js'
import { noteLeft, setUnread, sharedMap, toggleReaction } from '../../../ds-bot/src/client/shared-map.js'
import { createSource, EMPTY_ROSTER, indexRoster } from '../../../ds-bot/src/client/sources.js'
import { STORAGE, migrateStorage } from '../../../ds-bot/src/client/storage.js'
import { readMode, writeMode } from '../../../ds-bot/src/client/surface.js'
import { teamActions } from '../../../ds-bot/src/client/team-actions.js'
import { currentPart } from '../../../ds-bot/src/client/text.js'
import { registry } from '../../../ds-bot/src/client/themes.js'
import { openFeed } from './api.js'

// Memory news and connector states change without a notice on the feed.
const CATCH_UP_MS = 15_000
const READ_AGAIN = new Set(['hello', 'revision', 'live'])
const NO_WORK = { bots: {}, approvals: [] }
const EMPTY_PENDING = Object.freeze([])

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
  const ui = createSource({ details: null, view: 'details', renaming: false, tab: null, side: null, task: null, rightPanel: null, newChat: null, exchange: null, menu: null, voice: null, palette: null, quote: null, settings: null, memory: null, toast: null, signIn: null, renameAgent: null, unread: unreadStore.read(), reactions: reactionStore.read(), visits: {} })
  const activity = createSource({})
  const work = createSource(NO_WORK)
  const memoryNews = createSource({})
  const live = createSource({})
  const cards = createSource({})
  const heldCards = createSource({})
  const turnClock = createSource({})
  const update = createSource({ available: false, phase: 'idle' })
  const mergeUpdate = (value) => {
    if (!value || typeof value !== 'object') return
    update.set(previous => ({ ...previous, ...value, app: previous.app, ownApp: previous.ownApp }))
  }
  let wakeUpdate = () => {}
  let scheduleUpdate = () => {}
  const computer = createSource({})
  // Bot browsers need a webview bridge: DSH Desktop's, or the desktop app's of the
  // same shape. The host serves read_browser only in those two (`browser` in the state).
  const bridge = (globalThis.dshDesktop?.protocolVersion === 1 ? globalThis.dshDesktop.browser : globalThis.dsBotApp?.browser) ?? null
  const browsers = bridge ? createBotBrowsers({ bridge, createSource }) : null
  const browserHolds = browsers?.holds ?? createSource({})
  const browserPages = browsers?.pages ?? createSource({})
  const browserTabs = browsers?.tabs ?? createSource({})
  const layout = createSource({ wide: true })
  const surface = createSource({ mode: readMode() })
  // The Session facts: the list (each one's latest entry and change, and which one fills
  // the main view), the status (running, a reply not yet seen) and what was just sent.
  const sessions = createSource({ ids: [], byId: {} })
  const status = createSource(new Map())
  const sent = createSource({})
  const shown = createSource(null)
  const chat = createBus()
  // Remember positions in both modes so switching Bot <-> Classic preserves each side.
  let lastTeamSession = null
  let lastAgentSession = null
  const agentNewInFlight = new Map()
  let classicSeq = 0
  const sessionHooks = new Map()
  const streamingReply = new Set()

  const isAgentSessionId = id => Boolean(id && roster.getSnapshot().agentOf?.[id] !== undefined)
  const latestAgentSession = (agentId) => {
    const agent = roster.getSnapshot().agentsById?.[agentId]
    const ids = agent?.sessions ?? []
    if (ids.length === 0) return undefined
    const list = sessions.getSnapshot().byId
    return [...ids].sort((a, b) => {
      const diff = (list[b]?.updatedAt ?? 0) - (list[a]?.updatedAt ?? 0)
      return diff !== 0 ? diff : ids.indexOf(b) - ids.indexOf(a)
    })[0]
  }

  const refreshClassicSessions = async () => {
    const mySeq = ++classicSeq
    try {
      const res = await call('engine-classic-sessions')
      if (mySeq !== classicSeq) return
      const rows = Array.isArray(res?.sessions) ? res.sessions : []
      if (rows.length === 0) return
      sessions.set((list) => {
        const nextIds = [...list.ids]
        const nextById = { ...list.byId }
        for (const item of rows) {
          if (!item?.id) continue
          if (!nextIds.includes(item.id)) nextIds.push(item.id)
          const prev = nextById[item.id] ?? { id: item.id }
          nextById[item.id] = {
            ...prev,
            id: item.id,
            title: item.title || prev.title || '',
            displayTitle: item.title || prev.displayTitle || '',
            updatedAt: Math.max(prev.updatedAt ?? 0, item.updatedAt ?? 0),
            running: item.running === true,
            blank: item.blank === true,
            ...(item.workspaceId ? { workspaceId: item.workspaceId } : {}),
          }
        }
        return { ids: nextIds, byId: nextById }
      })
    } catch { /* host without classic metadata leaves existing rows intact */ }
  }

  const editRow = (id, edit) => sessions.set((list) => {
    const row = list.byId[id] ?? { id }
    return { ids: list.ids.includes(id) ? list.ids : [...list.ids, id], byId: { ...list.byId, [id]: edit(row) } }
  })
  const setStatus = (id, patch) => status.set((map) => {
    const entry = map.get(id) ?? {}
    if (Object.entries(patch).every(([key, value]) => (entry[key] ?? false) === value)) return map
    return new Map(map).set(id, { ...entry, ...patch })
  })
  const clearShown = () => {
    const before = shown.getSnapshot()
    if (before === null) return
    shown.set(null)
    editRow(before, row => ({ ...row, retainedBy: { mainView: 0 } }))
  }
  const show = (id) => {
    if (!id) return
    const snap = roster.getSnapshot()
    if (snap.agentOf?.[id] !== undefined) lastAgentSession = id
    else if (snap.byId?.[id] !== undefined || snap.roomsById?.[id] !== undefined) lastTeamSession = id
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

  const pruneSessions = (indexed) => {
    const activeShown = shown.getSnapshot()
    const keep = id => id === activeShown || indexed.byId[id] !== undefined || indexed.roomsById[id] !== undefined || indexed.agentOf?.[id] !== undefined
    sessions.set((list) => {
      if (list.ids.every(keep)) return list
      const ids = list.ids.filter(keep)
      const byId = {}
      for (const id of ids) byId[id] = list.byId[id]
      return { ids, byId }
    })
    status.set((map) => {
      let dirty = false
      for (const id of map.keys()) { if (!keep(id)) { dirty = true; break } }
      if (!dirty) return map
      const next = new Map()
      for (const [id, entry] of map) if (keep(id)) next.set(id, entry)
      return next
    })
    sent.set((state) => {
      const keys = Object.keys(state)
      if (keys.every(keep)) return state
      const next = {}
      for (const id of keys) if (keep(id)) next[id] = state[id]
      return next
    })
    for (const id of [...sessionHooks.keys()]) if (!keep(id)) sessionHooks.delete(id)
    for (const id of [...streamingReply]) {
      if (!keep(id)) {
        streamingReply.delete(id)
        actions.noteLive(id, 'reply', null)
      }
    }
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
    if (value.api !== undefined && JSON.stringify(value.api) !== JSON.stringify(current.api ?? null)) changed.api = value.api
    if (value.apiVia !== undefined && JSON.stringify(value.apiVia) !== JSON.stringify(current.apiVia ?? {})) changed.apiVia = value.apiVia
    if (value.imStatus !== undefined && JSON.stringify(value.imStatus) !== JSON.stringify(current.imStatus ?? {})) changed.imStatus = value.imStatus
    if (value.imVia !== undefined && JSON.stringify(value.imVia) !== JSON.stringify(current.imVia ?? {})) changed.imVia = value.imVia
    if (value.secrets !== undefined && JSON.stringify(value.secrets) !== JSON.stringify(current.secrets ?? [])) changed.secrets = value.secrets
    if (value.secretStore !== undefined && JSON.stringify(value.secretStore) !== JSON.stringify(current.secretStore ?? {})) changed.secretStore = value.secretStore
    if (value.memoryReviews !== undefined && JSON.stringify(value.memoryReviews) !== JSON.stringify(current.memoryReviews ?? {})) changed.memoryReviews = value.memoryReviews
    if (value.plugins !== undefined && JSON.stringify(value.plugins) !== JSON.stringify(current.plugins ?? null)) changed.plugins = value.plugins
    if (Object.keys(changed).length > 0 && current.ready) roster.set({ ...current, ...changed })
    if (value.unchanged || (value.revision === current.revision && value.modelsKey === current.modelsKey)) return
    // In a window with no visit record yet, everything already there counts as seen.
    if (Object.keys(seenAt).length === 0) leaveVisits([...value.bots, ...value.rooms].map(entry => entry.id))
    const indexed = indexRoster(value)
    roster.set(indexed)
    if ((indexed.agents ?? []).some(agent => (agent.sessions?.length ?? 0) > 0)) {
      void refreshClassicSessions()
    }
    // Follow a Bot or group chat onto its new segment when context rolls over or moves to background.
    const open = shown.getSnapshot()
    if (open) {
      const target = indexed.byId[open] ?? indexed.roomsById[open]
      const nextPart = target ? currentPart(target) : open
      if (nextPart && nextPart !== open) show(nextPart)
    } else if (surface.getSnapshot().mode === 'agent') {
      const firstAgent = (indexed.agents ?? [])[0]
      const latest = firstAgent ? (latestAgentSession(firstAgent.id) ?? firstAgent.sessions?.[0]) : undefined
      if (latest) show(latest)
    }
    pruneSessions(indexed)
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

  // Unified right sidebar workspace state: coexists with Bot/Group details, browser, side
  // chats, and tasks inside one shared `BotPanel` strip.
  const EMPTY_RIGHT_PANEL = { tabs: [], tab: 'files', file: null, fileSessionId: null, fileRoot: null, changes: null, terminalNonce: 0 }
  const STALE_WORKSPACE_TABS = new Set(['preview', 'changes'])
  const normalizeRightPanel = (prev) => {
    if (!prev || typeof prev !== 'object') return { ...EMPTY_RIGHT_PANEL, tabs: [] }
    const tabs = Array.isArray(prev.tabs)
      ? prev.tabs.filter(id => typeof id === 'string' && id !== '')
      : (typeof prev.tab === 'string' && prev.tab !== '' ? [prev.tab] : [])
    return { ...EMPTY_RIGHT_PANEL, ...prev, tabs }
  }
  const pruneStaleWorkspace = (prev) => {
    if (!prev) return null
    const normalized = normalizeRightPanel(prev)
    const keptTabs = normalized.tabs.filter(id => !STALE_WORKSPACE_TABS.has(id))
    if (keptTabs.length === 0) return null
    const nextTab = keptTabs.includes(normalized.tab) ? normalized.tab : keptTabs[keptTabs.length - 1]
    const changed = keptTabs.length !== normalized.tabs.length
      || nextTab !== prev.tab
      || prev.file !== null
      || prev.fileSessionId !== null
      || prev.fileRoot !== null
      || prev.changes !== null
    if (!changed) return prev
    return {
      ...normalized,
      tabs: keptTabs,
      tab: nextTab,
      file: null,
      fileSessionId: null,
      fileRoot: null,
      changes: null,
    }
  }
  const openWorkspaceTab = (tabId, updateFn, fallbackSubject = null) => {
    if (typeof tabId !== 'string' || tabId === '') return
    const snap = roster.getSnapshot()
    const fallbackId = shown.getSnapshot() ?? fallbackSubject ?? snap.mainBotId ?? snap.bots?.[0]?.id ?? null
    ui.set((state) => {
      const prev = normalizeRightPanel(state.rightPanel)
      const nextTabs = prev.tabs.includes(tabId) ? prev.tabs : [...prev.tabs, tabId]
      const base = { ...prev, tabs: nextTabs, tab: tabId }
      const nextPanel = typeof updateFn === 'function' ? updateFn(base) : base
      const details = state.details ?? fallbackId
      return {
        ...state,
        details,
        view: 'workspace',
        renaming: false,
        tab: null,
        panelYield: true,
        rightPanel: nextPanel,
      }
    })
  }

  const actions = {
    ...baseActions,
    closePanel: () => {
      baseActions.closePanel()
      ui.set(state => (state.rightPanel !== null ? { ...state, rightPanel: null } : state))
    },
    closeOverlay: () => {
      const hadDialog = Boolean(ui.getSnapshot().newChat || ui.getSnapshot().exchange)
      baseActions.closeOverlay()
      if (!hadDialog) {
        ui.set(state => (state.details === null && state.rightPanel !== null ? { ...state, rightPanel: null } : state))
      }
    },
    toggleDetails: (id, force) => {
      baseActions.toggleDetails(id, force)
      ui.set(state => (state.details === null && state.rightPanel !== null ? { ...state, rightPanel: null } : state))
    },
    openSettings: (...args) => { clearShortcuts(); return baseActions.openSettings(...args) },
    openPalette: (...args) => { clearShortcuts(); return baseActions.openPalette(...args) },
    openGroupSearch: (...args) => { clearShortcuts(); return baseActions.openGroupSearch?.(...args) },
    openNewChat: (...args) => { clearShortcuts(); return baseActions.openNewChat(...args) },
    learningAnswer: (id, approve) => after(call('learning-answer', { id, approve })),
    // The full-pane overlays sit above the conversation, so opening one dismisses them.
    // Switching conversations also clears any preview/diff belonging to the previous workspace.
    isAgentSession: id => isAgentSessionId(id),
    surfaceMode: () => surface.getSnapshot().mode,
    setSurface: async (mode) => {
      const nextMode = mode === 'agent' ? 'agent' : 'bot'
      const prevShown = shown.getSnapshot()
      if (prevShown) {
        if (isAgentSessionId(prevShown)) lastAgentSession = prevShown
        else lastTeamSession = prevShown
      }
      if ((nextMode === 'agent' && prevShown && !isAgentSessionId(prevShown))
        || (nextMode === 'bot' && prevShown && isAgentSessionId(prevShown))) {
        clearShown()
      }
      ui.set(state => ({
        ...state,
        details: null,
        view: 'details',
        renaming: false,
        tab: null,
        side: null,
        task: null,
        rightPanel: null,
        newChat: null,
        exchange: null,
        menu: null,
        palette: null,
        groupSearch: null,
        settings: null,
        shortcuts: false,
      }))
      writeMode(nextMode)
      surface.set({ mode: nextMode })
      const snap = roster.getSnapshot()
      if (nextMode === 'agent') {
        const agent = (snap.agents ?? [])[0]
        if (lastAgentSession && snap.agentOf?.[lastAgentSession] !== undefined) {
          actions.openAgentSession(lastAgentSession)
          return
        }
        if (agent) {
          const latest = latestAgentSession(agent.id)
          if (latest) { actions.openAgentSession(latest); return }
          if (!snap.readOnly) {
            try { await actions.newAgentSession(agent.id) } catch (error) { actions.reportError?.(error, 'agent-session') }
          }
          return
        }
        if (!snap.readOnly) {
          try { await actions.addAgent() } catch (error) { actions.reportError?.(error, 'agent-session') }
        }
        return
      }
      const targetTeam = lastTeamSession && (snap.byId?.[lastTeamSession] !== undefined || snap.roomsById?.[lastTeamSession] !== undefined)
        ? lastTeamSession
        : (snap.mainBotId ?? snap.bots?.[0]?.id)
      if (targetTeam) actions.openSession(targetTeam)
    },
    openSession: (id) => {
      if (isAgentSessionId(id)) {
        actions.openAgentSession(id)
        return
      }
      const next = partFor(id)
      const switched = next !== shown.getSnapshot()
      ui.set((state) => {
        const dropOverlay = Boolean(state.newChat || state.exchange || state.menu || state.palette || state.shortcuts)
        const rp = switched ? pruneStaleWorkspace(state.rightPanel) : state.rightPanel
        const foldWorkspace = switched && state.view === 'workspace' && rp === null
        if (!dropOverlay && rp === state.rightPanel && !foldWorkspace) return state
        return {
          ...state,
          ...(dropOverlay ? { newChat: null, exchange: null, menu: null, palette: null, shortcuts: false } : {}),
          ...(foldWorkspace ? { view: 'details' } : {}),
          rightPanel: rp,
        }
      })
      show(next)
    },
    openAgentSession: (sessionId) => {
      if (!sessionId) return
      const switched = sessionId !== shown.getSnapshot()
      lastAgentSession = sessionId
      ui.set((state) => {
        const rp = switched ? pruneStaleWorkspace(state.rightPanel) : state.rightPanel
        const keepPanel = Boolean(state.details && rp !== null && rp.tabs.length > 0)
        return {
          ...state,
          ...(keepPanel
            ? { details: sessionId, view: 'workspace', renaming: false, tab: null, side: null, task: null }
            : { details: null, view: 'details', renaming: false, tab: null, side: null, task: null }),
          newChat: null,
          exchange: null,
          menu: null,
          palette: null,
          groupSearch: null,
          shortcuts: false,
          rightPanel: keepPanel ? rp : null,
        }
      })
      show(sessionId)
    },
    addAgent: async (options = {}) => {
      const agentPreset = typeof options?.agentPreset === 'string' && options.agentPreset.trim() !== '' ? options.agentPreset.trim() : undefined
      const agent = await after(call('add-agent', agentPreset ? { agentPreset } : {}))
      await refreshClassicSessions()
      if (agent?.sessions?.[0] !== undefined) actions.openAgentSession(agent.sessions[0])
      return agent
    },
    openAgent: (agentId) => {
      const agent = roster.getSnapshot().agentsById?.[agentId]
      if (agent === undefined) return undefined
      const latest = latestAgentSession(agentId)
      if (latest === undefined) return actions.newAgentSession(agentId)
      actions.openAgentSession(latest)
      return latest
    },
    newAgentSession: async (agentId, options = {}) => {
      const agent = roster.getSnapshot().agentsById?.[agentId]
      if (agent === undefined) return undefined
      const agentPreset = typeof options?.agentPreset === 'string' && options.agentPreset.trim() !== '' ? options.agentPreset.trim() : undefined
      const flightKey = agentPreset ? `${agentId}:${agentPreset}` : agentId
      const existing = agentNewInFlight.get(flightKey)
      if (existing) return existing
      const workPromise = (async () => {
        const latest = latestAgentSession(agentId)
        const latestRow = latest ? sessions.getSnapshot().byId[latest] : undefined
        const { sessionId } = await after(call('agent-session', {
          agentId,
          ...(latestRow?.workspaceId ? { workspaceId: latestRow.workspaceId } : {}),
          ...(agentPreset ? { agentPreset } : {}),
        }))
        editRow(sessionId, row => ({ ...row, id: sessionId, updatedAt: Date.now(), blank: true }))
        actions.openAgentSession(sessionId)
        void refreshClassicSessions()
        return sessionId
      })().finally(() => { agentNewInFlight.delete(flightKey) })
      agentNewInFlight.set(flightKey, workPromise)
      return workPromise
    },
    archiveAgentSession: async (agentId, sessionId) => {
      await after(call('agent-archive', { agentId, sessionId }))
      if (lastAgentSession === sessionId) lastAgentSession = null
      if (shown.getSnapshot() === sessionId) {
        const snap = roster.getSnapshot()
        const rest = snap.agentsById?.[agentId]?.sessions ?? []
        if (rest.length > 0) actions.openAgent(agentId)
        else if (surface.getSnapshot().mode === 'agent') shown.set(null)
        else if (snap.mainBotId) actions.openSession(snap.mainBotId)
        else shown.set(null)
      }
      void refreshClassicSessions()
    },
    renameAgentSession: async (agentId, sessionId, title) => {
      await after(call('agent-rename', { agentId, sessionId, title }))
      const clean = String(title ?? '').trim()
      editRow(sessionId, row => ({ ...row, title: clean, displayTitle: clean, blank: false }))
      void refreshClassicSessions()
    },
    beginAgentRename: sessionId => ui.set(state => ({ ...state, renameAgent: sessionId })),
    endAgentRename: () => ui.set(state => (state.renameAgent ? { ...state, renameAgent: null } : state)),
    removeAgent: async (agentId) => {
      const owned = roster.getSnapshot().agentsById?.[agentId]?.sessions ?? []
      const result = await after(call('remove-agent', { agentId }))
      if (owned.includes(lastAgentSession)) lastAgentSession = null
      const currentShown = shown.getSnapshot()
      if (currentShown !== null && owned.includes(currentShown)) {
        const snap = roster.getSnapshot()
        if (surface.getSnapshot().mode === 'agent') shown.set(null)
        else if (snap.mainBotId) actions.openSession(snap.mainBotId)
        else shown.set(null)
      }
      return result
    },
    stopAgent: (agentId, sessionId) => after(call('stop-agent', sessionId ? { agentId, sessionId } : { agentId })),
    createClassicSession: (options = {}) => {
      const snap = roster.getSnapshot()
      if (snap.readOnly) return undefined
      const agent = (snap.agents ?? [])[0]
      return agent ? actions.newAgentSession(agent.id, options) : actions.addAgent(options)
    },
    startPresetCreator: async () => {
      const snap = roster.getSnapshot()
      if (snap.readOnly) return undefined
      const prevShown = shown.getSnapshot()
      if (prevShown && !isAgentSessionId(prevShown)) lastTeamSession = prevShown
      if (surface.getSnapshot().mode !== 'agent') {
        clearShown()
        surface.set({ mode: 'agent' })
        writeMode('agent')
      }
      return actions.createClassicSession({ agentPreset: 'cordis' })
    },
    refreshLocale: () => pull().catch(() => {}),
    refreshClassicSessions: async () => {
      await pull().catch(() => {})
      await refreshClassicSessions()
    },
    landOn: id => show(partFor(id)),
    toggleSidebar: () => layout.set(state => ({ ...state, wide: !state.wide })),
    setSidebarWide: next => layout.set(state => (state.wide === Boolean(next) ? state : { ...state, wide: Boolean(next) })),
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
    hasRightSidebar: () => true,
    canOpenFiles: () => true,
    canOpenTerminal: () => !roster.getSnapshot().readOnly,
    openFiles: () => openWorkspaceTab('files'),
    openFile: (path) => {
      const target = typeof path === 'string' ? path : (typeof path?.path === 'string' ? path.path : '')
      if (target === '') return
      const fileSessionId = typeof path?.sessionId === 'string' && path.sessionId !== '' ? path.sessionId : null
      const fileRoot = typeof path?.root === 'string' && path.root !== '' ? path.root : null
      openWorkspaceTab('preview', prev => ({ ...prev, file: target, fileSessionId, fileRoot }), fileSessionId)
    },
    openChanges: async (changes) => {
      if (!changes || typeof changes !== 'object' || typeof changes.sessionId !== 'string' || !Number.isInteger(changes.seq)) return
      let available = false
      try { available = (await call('changes-check', { sessionId: changes.sessionId, seq: changes.seq })) === true } catch { available = false }
      if (!available) { actions.notice?.(t('These changes are no longer available')); return }
      openWorkspaceTab('changes', prev => ({ ...prev, changes }), changes.sessionId)
    },
    newTerminal: () => openWorkspaceTab('terminal', prev => ({ ...prev, terminalNonce: (prev?.terminalNonce ?? 0) + 1 })),
    setRightPanelTab: (tabId) => openWorkspaceTab(tabId),
    closeWorkspaceTab: (tabId) => {
      if (typeof tabId !== 'string' || tabId === '') return
      const snap = roster.getSnapshot()
      ui.set((state) => {
        if (!state.rightPanel) return state
        const prev = normalizeRightPanel(state.rightPanel)
        const remaining = prev.tabs.filter(id => id !== tabId)
        if (remaining.length > 0) {
          return {
            ...state,
            rightPanel: {
              ...prev,
              tabs: remaining,
              tab: prev.tab === tabId ? remaining[remaining.length - 1] : prev.tab,
              ...(tabId === 'preview' ? { file: null, fileSessionId: null, fileRoot: null } : {}),
              ...(tabId === 'changes' ? { changes: null } : {}),
            },
          }
        }
        if (state.view !== 'workspace') return { ...state, rightPanel: null }
        const subjectId = state.details
        const bot = subjectId ? snap.byId?.[subjectId] : undefined
        const room = subjectId ? snap.roomsById?.[subjectId] : undefined
        if (bot || room) {
          const hasSide = Boolean(bot && state.side && (snap.sideChats?.[bot.id] ?? []).some(chat => chat?.id === state.side))
          const hasBrowser = Boolean(
            bot
            && snap.browser === true
            && browsers
            && (browsers.tabs.getSnapshot()[bot.id]?.ids?.length ?? 0) > 0,
          )
          return {
            ...state,
            rightPanel: null,
            view: hasSide ? 'side' : hasBrowser ? 'browser' : 'details',
            ...(hasSide ? {} : { side: null }),
            renaming: false,
            tab: null,
          }
        }
        return {
          ...state,
          details: null,
          view: 'details',
          renaming: false,
          tab: null,
          side: null,
          task: null,
          rightPanel: null,
        }
      })
    },
    closeRightPanel: () => actions.closePanel(),
    toggleRightPanel: () => {
      const state = ui.getSnapshot()
      if (state.details && state.view === 'workspace') actions.closePanel()
      else actions.openFiles()
    },
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
      sent.set(state => ({ ...state, [sessionId]: [...(state[sessionId] ?? EMPTY_PENDING), { placement: 'direct', time: Date.now() }] }))
    },
    checkUpdate: async () => {
      const value = await call('update-check', { fresh: true })
      mergeUpdate(value)
      scheduleUpdate(value)
    },
    installUpdate: async () => {
      const value = await call('update-install')
      mergeUpdate(value)
      wakeUpdate()
    },
    installDshUpdate: async () => {
      const dsh = await call('dsh-update-install')
      update.set(previous => ({ ...previous, dsh }))
      wakeUpdate()
    },
    checkOwnApp: async () => { await globalThis.dsBotApp?.updates?.check?.() },
    installOwnApp: async () => { await globalThis.dsBotApp?.updates?.install?.() },
    openOwnApp: async () => { await globalThis.dsBotApp?.updates?.open?.() },
    downloadOwnApp: async () => { await globalThis.dsBotApp?.updates?.download?.() },
    setOwnAppAutoUpdate: async (enabled) => { await globalThis.dsBotApp?.updates?.setAutoUpdate?.(enabled === true) },
  }

  // Without the Desktop bridge these stay undefined, and no browser control renders.
  if (browsers) {
    Object.assign(actions, {
      // The globe / `+ -> Browser` trigger: the Bot's active tab in the browser view, or a new tab.
      openBrowser: (id) => {
        const bot = roster.getSnapshot().byId[id]
        if (!bot) return
        browsers.ensureTabs(bot.id)
        if (browsers.tabs.getSnapshot()[bot.id]?.active == null) browsers.openTab(bot.id)
        ui.set(state => ({ ...state, details: id, view: 'browser', renaming: false, tab: null, panelYield: true }))
      },
      // `+` on the strip or the drawer's new-tab card: a blank tab in the browser view.
      browserNewTab: (id) => {
        const bot = roster.getSnapshot().byId[id]
        if (!bot) return null
        browsers.ensureTabs(bot.id)
        const tabId = browsers.openTab(bot.id)
        ui.set(state => ({ ...state, details: id, view: 'browser', renaming: false, tab: null, panelYield: true }))
        return tabId
      },
      // A drawer card: its tab active, the panel on the browser view.
      browserPick: (id, tabId) => {
        const bot = roster.getSnapshot().byId[id]
        if (!bot) return
        browsers.activate(bot.id, tabId)
        ui.set(state => ({ ...state, details: id, view: 'browser', renaming: false, tab: null, panelYield: true }))
      },
      browserEnsure: botId => browsers.ensureTabs(botId),
      browserCloseTab: async (botId, tabId) => {
        await browsers.closeTab(botId, tabId)
        const remaining = browsers.tabs.getSnapshot()[botId]
        if (remaining && remaining.ids.length > 0) return
        const snap = roster.getSnapshot()
        ui.set((state) => {
          if (!state.details || state.view !== 'browser') return state
          const subjectBot = snap.byId?.[state.details]
          if (subjectBot && subjectBot.id !== botId) return state
          const hasWorkspace = (state.rightPanel?.tabs?.length ?? 0) > 0
          if (hasWorkspace) return { ...state, view: 'workspace', renaming: false, tab: null }
          const hasSide = Boolean(subjectBot && state.side && (snap.sideChats?.[subjectBot.id] ?? []).some(chat => chat?.id === state.side))
          if (hasSide) return { ...state, view: 'side', renaming: false, tab: null }
          return { ...state, view: 'details', renaming: false, tab: null }
        })
      },
      browserActivate: (botId, tabId) => browsers.activate(botId, tabId),
      browserShow: (tabId, box) => browsers.show(tabId, box),
      browserNavigate: (tabId, input) => browsers.navigate(tabId, input),
      browserCommand: (tabId, name) => browsers.command(tabId, name),
      browserFocus: tabId => browsers.focus(tabId),
      browserTakeover: bridge.views ? async (botId) => {
        const result = await call('browser-takeover', { botId })
        await bridge.views.hold(botId, true)
        return result
      } : undefined,
      browserStop: bridge.views ? async (botId) => {
        const result = await call('browser-stop', { botId })
        await bridge.views.hold(botId, true)
        return result
      } : undefined,
      // `answer` is a handoff card's { callId, outcome }; the panel's Give back sends none.
      browserGiveBack: bridge.views ? async (botId, answer = {}) => {
        const result = await call('browser-give-back', { botId, ...answer })
        await bridge.views.hold(botId, false)
        return result
      } : undefined,
      // Cookie imports, only where the bridge offers them (the desktop app): an installed
      // browser profile, a file, or pasted cookies/cURL is previewed, then applied into
      // the Bot's storage key.
      browserImport: typeof bridge.importSources === 'function' ? {
        sources: () => bridge.importSources(),
        probe: typeof bridge.importProbe === 'function' ? source => bridge.importProbe(source) : null,
        pick: () => bridge.importPick(),
        paste: typeof bridge.importPaste === 'function' ? (text, defaultUrl) => bridge.importPaste(text, defaultUrl) : null,
        launch: typeof bridge.importLaunch === 'function' ? source => bridge.importLaunch(source) : null,
        openPermission: typeof bridge.importOpenPermission === 'function' ? () => bridge.importOpenPermission() : null,
        live: (source, close, requestId) => bridge.importLive(source, close, requestId),
        apply: (botId, pending, options) => bridge.importApply(`bot:${botId}`, pending, options),
        cancel: pending => bridge.importCancel(pending),
      } : null,
    })
  }

  // Running and the tool at work come with the team's state; the plugin reads them from
  // DSH's Session status and its own tool cells.
  const followWork = () => {
    const snap = work.getSnapshot()
    const bots = snap.bots ?? {}
    const rooms = snap.rooms ?? {}
    const agentsWork = snap.agents ?? {}
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
    const turns = snap.turns ?? {}
    for (const agent of r.agents ?? []) {
      const anyRunning = Object.keys(turns).some(sid => (agent.sessions ?? []).includes(sid))
      for (const sid of agent.sessions ?? []) {
        const running = turns[sid] !== undefined || (!anyRunning && agentsWork[agent.id] !== undefined && sid === shown.getSnapshot())
        setStatus(sid, { running })
      }
    }
  }
  roster.subscribe(followWork)
  work.subscribe(followWork)

  const onFeed = (event, data) => {
    if (event === 'hello') {
      for (const sessionId of streamingReply) actions.noteLive(sessionId, 'reply', null)
      streamingReply.clear()
    }
    if (event === 'message' && data?.sessionId && data.item) {
      const { sessionId, item } = data
      const text = item.kind === 'bot' || item.kind === 'user' ? item.text : ''
      editRow(sessionId, row => ({
        ...row,
        updatedAt: Math.max(row.updatedAt ?? 0, item.time ?? 0),
        // The sidebar's preview line; turn -1 is never a hidden exchange turn.
        projectionValues: text ? { turnOutline: [{ turn: -1, [item.kind === 'bot' ? 'response' : 'prompt']: text }] } : row.projectionValues,
      }))
      if (item.kind === 'bot') {
        if (streamingReply.delete(sessionId)) actions.noteLive(sessionId, 'reply', null)
        if (shown.getSnapshot() !== sessionId) setStatus(sessionId, { completionUnread: true })
      }
      if (item.kind === 'user') sent.set(state => (state[sessionId]?.length ? { ...state, [sessionId]: state[sessionId].slice(1) } : state))
    }
    // While a reply streams in, it stands in for the activity row; notify only on transitions.
    if (event === 'stream' && data?.sessionId) {
      const streaming = data.phase === undefined && Boolean(data.text)
      if (streaming) {
        if (!streamingReply.has(data.sessionId)) {
          streamingReply.add(data.sessionId)
          actions.noteLive(data.sessionId, 'reply', { text: true })
        }
      } else if (streamingReply.delete(data.sessionId)) {
        actions.noteLive(data.sessionId, 'reply', null)
      }
    }
    chat.emit(event, data)
  }

  const start = () => {
    let stopped = false
    let timer
    const read = () => {
      void pull().catch((error) => {
        if (stopped) return
        console.warn('[ds-bot] state', error)
        if (!roster.getSnapshot().ready) actions.reportError(error, 'state')
      })
    }
    const startTimer = () => {
      if (timer !== undefined || stopped) return
      timer = setInterval(read, CATCH_UP_MS)
    }
    const stopTimer = () => {
      if (timer === undefined) return
      clearInterval(timer)
      timer = undefined
    }
    const onVisibility = () => {
      if (stopped) return
      if (document.hidden) stopTimer()
      else { read(); startTimer() }
    }
    read()
    let updateTimer
    const nextUpdateDelay = value => (value?.phase === 'installing' || value?.dsh?.phase === 'installing' ? 2000 : 60 * 60_000)
    const armUpdate = (value) => {
      clearTimeout(updateTimer)
      if (!stopped) updateTimer = setTimeout(() => { void pollUpdate() }, nextUpdateDelay(value))
    }
    const pollUpdate = async () => {
      clearTimeout(updateTimer)
      if (stopped) return
      const value = await call('update-check', { fresh: false }).catch(() => null)
      if (stopped) return
      mergeUpdate(value)
      armUpdate(value)
    }
    wakeUpdate = () => { void pollUpdate() }
    scheduleUpdate = armUpdate
    void pollUpdate()
    let unsubscribeOwnApp = null
    const ownAppUpdates = globalThis.dsBotApp?.updates ?? null
    if (ownAppUpdates?.state && ownAppUpdates.subscribe) {
      const takeOwnApp = (ownApp) => {
        if (!stopped && ownApp) update.set(previous => ({ ...previous, ownApp }))
      }
      void Promise.resolve(ownAppUpdates.state()).then(takeOwnApp, () => {})
      unsubscribeOwnApp = ownAppUpdates.subscribe(takeOwnApp)
    }
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
    let stopBrowsers = null
    if (browsers) {
      let stopReads = null
      const syncBrowsers = () => {
        if (stopped) return
        const snapshot = roster.getSnapshot()
        if (!snapshot.ready) return
        const on = snapshot.browser === true
        if (on && !stopReads) stopReads = serveBrowserReads({ browsers, post: call })
        if (!on && stopReads) { stopReads(); stopReads = null }
        // A Bot deleted here or in another window takes its guests and saved tabs along.
        void browsers.retain(snapshot.bots.map(bot => bot.id)).catch(() => {})
        // A panel open on a deleted subject or unavailable browser falls back cleanly to
        // workspace (if open), details (if subject still exists), or closes completely.
        ui.set((state) => {
          if (!state.details) return state
          const hasBot = Boolean(snapshot.byId[state.details])
          const hasRoom = Boolean(snapshot.roomsById?.[state.details])
          const hasWorkspace = (state.rightPanel?.tabs?.length ?? 0) > 0
          if (state.view === 'browser') {
            if (on && hasBot) return state
            if (hasWorkspace) return { ...state, view: 'workspace' }
            if (hasBot || hasRoom) return { ...state, view: 'details' }
            return { ...state, details: null, view: 'details', renaming: false, tab: null, side: null, task: null, rightPanel: null }
          }
          if (!hasBot && !hasRoom && !hasWorkspace) {
            return { ...state, details: null, view: 'details', renaming: false, tab: null, side: null, task: null, rightPanel: null }
          }
          return state
        })
      }
      syncBrowsers()
      const offBrowserRoster = roster.subscribe(syncBrowsers)
      stopBrowsers = () => {
        offBrowserRoster()
        stopReads?.()
        stopReads = null
        browsers.dispose()
      }
    }
    // Computer use desktop bridge: floating indicator + tray rows, cursor long-poll,
    // OS idle-time sampling for foreground gate, and tray/indicator stop actions.
    const cleanups = []
    const appComputer = globalThis.dsBotApp
    if (typeof appComputer?.computer === 'function') {
      const nameOf = id => roster.getSnapshot().byId[id]?.name ?? 'a Bot'
      const syncComputer = () => {
        if (stopped) return
        const live = computer.getSnapshot()
        const look = id => lookOf(roster.getSnapshot().byId[id])
        const rows = (live.leases ?? []).map(entry => ({
          botId: entry.botId,
          name: nameOf(entry.botId),
          app: entry.kind === 'foreground' ? t('In the foreground') : entry.appName,
          label: entry.kind === 'foreground' ? t('{name} · foreground', { name: nameOf(entry.botId) }) : `${nameOf(entry.botId)} · ${entry.appName}`,
          color: look(entry.botId).color,
          avatar: look(entry.botId).image,
        }))
        for (const [botId, entry] of Object.entries(live.bots ?? {})) {
          if (entry.waitingFor === 'user-idle') rows.push({ botId, waiting: true, name: nameOf(botId), app: t('waits for the computer'), label: t('{name} waits for the computer', { name: nameOf(botId) }), color: look(botId).color, avatar: look(botId).image })
        }
        appComputer.computer({
          rows,
          labels: { stop: t('Stop'), stopAll: t('Stop all'), letGo: t('Let it continue') },
        })
      }
      syncComputer()
      cleanups.push(computer.subscribe(syncComputer))
      cleanups.push(roster.subscribe(() => {
        const live = computer.getSnapshot()
        if ((live.leases?.length ?? 0) > 0 || Object.values(live.bots ?? {}).some(entry => entry?.waitingFor === 'user-idle')) {
          syncComputer()
        }
      }))
    }
    if (typeof appComputer?.computerCursor === 'function') {
      const cursorAbort = new AbortController()
      let wakeEnabled = null
      let cancelPause = null
      const waitEnabled = () => new Promise((resolve) => {
        if (stopped || roster.getSnapshot().computer?.enabled === true) { resolve(); return }
        wakeEnabled = resolve
      })
      const pause = ms => new Promise((resolve) => {
        if (stopped) { resolve(); return }
        const delay = setTimeout(() => {
          if (cancelPause === cancel) cancelPause = null
          resolve()
        }, ms)
        const cancel = () => {
          clearTimeout(delay)
          if (cancelPause === cancel) cancelPause = null
          resolve()
        }
        cancelPause = cancel
      })
      const notifyEnabled = () => {
        if (wakeEnabled) { const fn = wakeEnabled; wakeEnabled = null; fn() }
      }
      const offCursorRoster = roster.subscribe(() => {
        if (roster.getSnapshot().computer?.enabled === true) notifyEnabled()
      })
      const runCursor = async () => {
        let after = 0
        while (!stopped) {
          if (roster.getSnapshot().computer?.enabled !== true) { await waitEnabled(); continue }
          try {
            const reply = await call('computer-cursor-wait', { after }, cursorAbort.signal)
            if (stopped) break
            for (const event of reply?.events ?? []) {
              if (Number.isFinite(event.seq) && event.seq > after) after = event.seq
              if (Number.isFinite(event.t) && Number.isFinite(reply?.now) && reply.now - event.t > 3000) continue
              const botLook = lookOf(roster.getSnapshot().byId[event.botId])
              appComputer.computerCursor({ ...event, color: botLook.color, avatar: botLook.image })
            }
          } catch {
            if (!stopped) await pause(2000)
          }
        }
      }
      void runCursor()
      cleanups.push(() => { cursorAbort.abort(); offCursorRoster(); notifyEnabled(); cancelPause?.() })
    }
    if (typeof appComputer?.idleSeconds === 'function') {
      let idleTimer = 0
      const pushIdle = () => {
        const current = roster.getSnapshot()
        if (current.computer?.enabled !== true) return
        if (!needsIdleSample(computer.getSnapshot(), current.computer)) return
        void Promise.resolve(appComputer.idleSeconds()).then((idle) => {
          if (Number.isFinite(idle)) call('computer-user-active', { idleSeconds: idle }).catch(() => {})
        }).catch(() => {})
      }
      const syncIdle = () => {
        const enabled = roster.getSnapshot().computer?.enabled === true
        if (enabled && !idleTimer) idleTimer = setInterval(pushIdle, 2000)
        else if (!enabled && idleTimer) { clearInterval(idleTimer); idleTimer = 0 }
      }
      syncIdle()
      const offIdleRoster = roster.subscribe(syncIdle)
      cleanups.push(() => { offIdleRoster(); if (idleTimer) clearInterval(idleTimer) })
    }
    if (typeof appComputer?.onComputerAction === 'function') {
      const offAction = appComputer.onComputerAction(({ kind, botId }) => {
        if (kind === 'stop') void actions.computerStop(botId)
        else if (kind === 'stopall') void actions.computerStop(null, true)
        else if (kind === 'letgo') void actions.computerAllowForeground(botId)
      })
      if (typeof offAction === 'function') cleanups.push(offAction)
    }
    if (typeof document === 'undefined' || !document.hidden) startTimer()
    if (typeof document?.addEventListener === 'function') document.addEventListener('visibilitychange', onVisibility)
    const onPageHide = () => leaveVisits(Object.keys(ui.getSnapshot().visits ?? {}))
    window.addEventListener('pagehide', onPageHide)
    return () => {
      stopped = true
      clearTimeout(updateTimer)
      wakeUpdate = () => {}
      scheduleUpdate = () => {}
      unsubscribeOwnApp?.()
      closeFeed()
      stopApprovalNotices()
      stopBrowsers?.()
      for (const cleanup of cleanups) cleanup()
      stopTimer()
      if (typeof document?.removeEventListener === 'function') document.removeEventListener('visibilitychange', onVisibility)
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
    useSurface: use(surface),
    useShown: use(shown),
  }
  // The Session one view shows, as DSH hands it to a view: what was just sent there.
  const sessionHook = (sessionId) => {
    let hook = sessionHooks.get(sessionId)
    if (hook === undefined) {
      let lastPending = EMPTY_PENDING
      let lastSlice = { pendingSubmissions: EMPTY_PENDING }
      hook = selector => useSelect(sent, (state) => {
        const pending = state[sessionId] ?? EMPTY_PENDING
        if (pending !== lastPending) {
          lastPending = pending
          lastSlice = { pendingSubmissions: pending }
        }
        return selector(lastSlice)
      })
      sessionHooks.set(sessionId, hook)
    }
    return hook
  }
  return { actions, hooks, sessionHook, chat, start }
}
