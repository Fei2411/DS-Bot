// The team as the window keeps it: the Bot views' own sources and actions, fed by the
// engine's `state` endpoint and live feed. The views also read a few Session facts that
// DSH keeps for them in the plugin; here the window keeps those as well.
import { useRef, useSyncExternalStore } from 'react'
import { watchAgentTerminals } from '../../../ds-bot/src/client/agent-terminals.js'
import { call } from '../../../ds-bot/src/client/api.js'
import { noticeApprovals } from '../../../ds-bot/src/client/approval-notices.js'
import { createAvatarRefCache } from '../../../ds-bot/src/client/avatar-refs.js'
import { createBotBrowsers, serveBrowserReads } from '../../../ds-bot/src/client/bot-browsers.js'
import { watchBotCompletions } from '../../../ds-bot/src/client/bot-completions.js'
import { workPhrase } from '../../../ds-bot/src/client/cells.js'
import { pruneDrafts } from '../../../ds-bot/src/client/draft-keep.js'
import { sameVersion } from '../../../ds-bot/src/client/dsh-offer.js'
import { frameLayout, readSidebar, SIDEBAR_MAX, SIDEBAR_MIN, toggledPref, writeSidebar } from '../../../ds-bot/src/client/frame-layout.js'
import { language, t } from '../../../ds-bot/src/client/i18n.js'
import { lookOf, toolState } from '../../../ds-bot/src/client/mark.js'
import { messageJumpTarget } from '../../../ds-bot/src/client/message-jump.js'
import { needsIdleSample } from '../../../ds-bot/src/client/polling.js'
import { createQuestionDrafts } from '../../../ds-bot/src/client/question-draft.js'
import { noteLeft, setUnread, sharedMap, toggleReaction } from '../../../ds-bot/src/client/shared-map.js'
import { createSource, EMPTY_ROSTER, indexRoster } from '../../../ds-bot/src/client/sources.js'
import { requestPreparation } from '../../../ds-bot/src/client/speech.js'
import { STORAGE, migrateStorage } from '../../../ds-bot/src/client/storage.js'
import { readMode, writeMode } from '../../../ds-bot/src/client/surface.js'
import { sectionFoldWrites, teamActions } from '../../../ds-bot/src/client/team-actions.js'
import { currentPart } from '../../../ds-bot/src/client/text.js'
import { registry } from '../../../ds-bot/src/client/themes.js'
import { openFeed } from './api.js'
import { createDesktopAccountBridge, publishDesktopAccountState, subscribeDesktopAccountState } from './deepseek-account.js'

export { publishDesktopAccountState, subscribeDesktopAccountState }
import { pruneFailedSends } from './failed-send-bar.js'
import { slots } from './slots.js'

// Memory news and connector states change without a notice on the feed.
const CATCH_UP_MS = 15_000
const RECONNECT_NOTICE_MS = 2_000
const NO_WORK = { bots: {}, approvals: [] }
const EMPTY_PENDING = Object.freeze([])
export const CLASSIC_BROWSER_OWNER = 'classic'

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
  let savedPrefs = {}
  try { savedPrefs = JSON.parse(localStorage.getItem(STORAGE.prefs) ?? '{}') ?? {} } catch { savedPrefs = {} }
  const unreadStore = sharedMap(STORAGE.unread)
  const reactionStore = sharedMap(STORAGE.reactions)
  // When each conversation was last left; a visit compares new entries against it.
  const seenStore = sharedMap(STORAGE.seen)
  let seenAt = seenStore.read()
  const roster = createSource({ ...EMPTY_ROSTER, prefs: savedPrefs })
  const botCompletions = createSource({})
  const ui = createSource({ details: null, view: 'details', renaming: false, tab: null, side: null, task: null, rightPanel: null, newChat: null, exchange: null, menu: null, voice: null, palette: null, quote: null, pendingOpen: null, settings: null, releaseNotes: null, memory: null, toast: null, signIn: null, renameAgent: null, unread: unreadStore.read(), reactions: reactionStore.read(), visits: {} })
  const activity = createSource({})
  const work = createSource(NO_WORK)
  const userQuestions = createSource([])
  const sessionQueues = createSource({})
  const mergeSessionQueues = (nextMap) => {
    if (!nextMap || typeof nextMap !== 'object') return
    sessionQueues.set((prev) => {
      const prevKeys = Object.keys(prev)
      const nextKeys = Object.keys(nextMap)
      let changed = prevKeys.length !== nextKeys.length
      const merged = {}
      for (const sid of nextKeys) {
        const prevRows = prev[sid]
        const nextRows = nextMap[sid]
        if (prevRows !== undefined && JSON.stringify(prevRows) === JSON.stringify(nextRows)) {
          merged[sid] = prevRows
        } else {
          merged[sid] = nextRows
          changed = true
        }
      }
      return changed ? merged : prev
    })
  }
  const memoryNews = createSource({})
  const live = createSource({})
  const cards = createSource({})
  const heldCards = createSource({})
  const turnClock = createSource({})
  const update = createSource({ available: false, phase: 'idle' })
  const connection = createSource({ status: 'connected', error: null, code: null })
  let restartFeed = () => {}
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
  let sidebarSaved = readSidebar()
  const layout = createSource({ ...sidebarSaved, wide: sidebarSaved.pref === 'open' })
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
  let terminalNonceSeq = 0
  let navSeq = 0
  const recovering = new Set()
  const agentNewInFlight = new Map()
  let classicSeq = 0
  const sessionHooks = new Map()
  const streamingReply = new Set()
  const closingRepliesBySession = new Map()
  const draftFileStore = new Map()
  let draftFileSeq = 0
  const lastFeedReplySeq = new Map()
  const lastGroupNoticeSeq = new Map()

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
    finishMessageJump(ui.getSnapshot().messageJump)
    editRow(before, row => ({ ...row, retainedBy: { mainView: 0 } }))
  }
  const finishMessageJump = jump => { if (jump) ui.set(state => state.messageJump === jump ? { ...state, messageJump: null } : state) }
  const show = (id) => {
    if (!id) return
    const snap = roster.getSnapshot()
    if (snap.agentOf?.[id] !== undefined) lastAgentSession = id
    else if (snap.byId?.[id] !== undefined || snap.roomsById?.[id] !== undefined) lastTeamSession = id
    if (shown.getSnapshot() === id) return
    const before = shown.getSnapshot()
    finishMessageJump(ui.getSnapshot().messageJump)
    shown.set(id)
    if (before) editRow(before, row => ({ ...row, retainedBy: { mainView: 0 } }))
    editRow(id, row => ({ ...row, replyCount: row.replyCount ?? 0, retainedBy: { mainView: 1 } }))
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
    for (const id of [...turnFactsBySession.keys()]) if (!keep(id)) turnFactsBySession.delete(id)
    for (const id of [...closingRepliesBySession.keys()]) if (!keep(id)) closingRepliesBySession.delete(id)
    for (const id of [...lastFeedMessageCursor.keys()]) if (!keep(id)) lastFeedMessageCursor.delete(id)
    for (const id of [...confirmedUsersBySession.keys()]) if (!keep(id)) confirmedUsersBySession.delete(id)
    for (const id of [...evictedConfirmedSeqBySession.keys()]) if (!keep(id)) evictedConfirmedSeqBySession.delete(id)
    for (const id of [...maxConfirmedUserSeqBySession.keys()]) if (!keep(id)) maxConfirmedUserSeqBySession.delete(id)
    for (const [fileId, entry] of [...draftFileStore.entries()]) {
      if (entry?.sessionId && !keep(entry.sessionId)) draftFileStore.delete(fileId)
    }
    for (const id of [...lastFeedReplySeq.keys()]) if (!keep(id)) lastFeedReplySeq.delete(id)
    for (const id of [...lastGroupNoticeSeq.keys()]) if (!keep(id)) lastGroupNoticeSeq.delete(id)
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
  const foldWrites = sectionFoldWrites()
  const avatarRefs = createAvatarRefCache(call)
  let avatarIncomplete = false
  let liveKey
  const persistPrefs = (prefs) => {
    if (!prefs || typeof prefs !== 'object') return
    try {
      localStorage.setItem(STORAGE.prefs, JSON.stringify({
        theme: prefs.theme,
        accent: prefs.accent,
        motion: prefs.motion,
        layout: prefs.layout,
        effects: prefs.effects,
        width: prefs.width,
        flatWidth: prefs.flatWidth,
        thinking: prefs.thinking,
        defaultBotModel: prefs.defaultBotModel,
        enterToSend: prefs.enterToSend,
      }))
    } catch { /* storage unavailable */ }
  }
  const pull = async () => {
    const order = ++pulls
    const known = roster.getSnapshot()
    const since = avatarIncomplete ? -1 : known.revision
    const value = await call('state', { since, models: known.modelsKey ?? '', live: liveKey, locale: language(), avatars: 'ref' })
    if (order < applied) return
    applied = order
    const liveSame = liveKey !== undefined && value.liveKey !== undefined && value.liveKey === liveKey
    if (value.liveKey !== undefined) liveKey = value.liveKey
    if (!liveSame) {
      if (value.activity !== undefined) setChanged(activity, value.activity)
      if (value.work !== undefined) setChanged(work, value.work)
      if (value.userQuestions !== undefined) setChanged(userQuestions, value.userQuestions)
      if (value.sessionQueues !== undefined) mergeSessionQueues(value.sessionQueues)
      if (value.computerLive !== undefined) setChanged(computer, value.computerLive)
      if (value.browserHolds !== undefined) setChanged(browserHolds, value.browserHolds)
      if (value.memoryNews !== undefined) noteNews(value.memoryNews)
    }
    const current = roster.getSnapshot()
    const computeChanged = (base) => {
      const next = {}
      if (value.readOnly !== undefined && (value.readOnly ?? null) !== (base.readOnly ?? null)) next.readOnly = value.readOnly
      if (value.connectors !== undefined && JSON.stringify(value.connectors) !== JSON.stringify(base.connectors ?? [])) next.connectors = value.connectors
      if (value.capabilityStatuses !== undefined && JSON.stringify(value.capabilityStatuses) !== JSON.stringify(base.capabilityStatuses ?? {})) next.capabilityStatuses = value.capabilityStatuses
      if (value.learning !== undefined && JSON.stringify(value.learning) !== JSON.stringify(base.learning ?? {})) next.learning = value.learning
      // What waits for the user across the team (ds-bot/src/host/inbox.js).
      if (value.inbox !== undefined && JSON.stringify(value.inbox) !== JSON.stringify(base.inbox ?? null)) next.inbox = value.inbox
      if (value.learningSettled !== undefined && JSON.stringify(value.learningSettled) !== JSON.stringify(base.learningSettled ?? {})) next.learningSettled = value.learningSettled
      if (value.btwCards !== undefined && JSON.stringify(value.btwCards) !== JSON.stringify(base.btwCards ?? {})) next.btwCards = value.btwCards
      if (value.sideChats !== undefined && JSON.stringify(value.sideChats) !== JSON.stringify(base.sideChats ?? {})) next.sideChats = value.sideChats
      if (value.phone !== undefined && JSON.stringify(value.phone) !== JSON.stringify(base.phone ?? null)) next.phone = value.phone
      if (value.api !== undefined && JSON.stringify(value.api) !== JSON.stringify(base.api ?? null)) next.api = value.api
      if (value.apiVia !== undefined && JSON.stringify(value.apiVia) !== JSON.stringify(base.apiVia ?? {})) next.apiVia = value.apiVia
      if (value.imStatus !== undefined && JSON.stringify(value.imStatus) !== JSON.stringify(base.imStatus ?? {})) next.imStatus = value.imStatus
      if (value.imVia !== undefined && JSON.stringify(value.imVia) !== JSON.stringify(base.imVia ?? {})) next.imVia = value.imVia
      if (value.secrets !== undefined && JSON.stringify(value.secrets) !== JSON.stringify(base.secrets ?? [])) next.secrets = value.secrets
      if (value.secretStore !== undefined && JSON.stringify(value.secretStore) !== JSON.stringify(base.secretStore ?? {})) next.secretStore = value.secretStore
      if (value.memoryReviews !== undefined && JSON.stringify(value.memoryReviews) !== JSON.stringify(base.memoryReviews ?? {})) next.memoryReviews = value.memoryReviews
      if (value.plugins !== undefined && JSON.stringify(value.plugins) !== JSON.stringify(base.plugins ?? null)) next.plugins = value.plugins
      if (value.speech !== undefined && Boolean(value.speech) !== Boolean(base.speech)) next.speech = Boolean(value.speech)
      if (value.telemetryPrompt !== undefined && Boolean(value.telemetryPrompt) !== Boolean(base.telemetryPrompt)) next.telemetryPrompt = Boolean(value.telemetryPrompt)
      if (value.releaseNotes !== undefined && JSON.stringify(value.releaseNotes) !== JSON.stringify(base.releaseNotes ?? null)) next.releaseNotes = value.releaseNotes
      return next
    }
    if (value.unchanged || (!avatarIncomplete && value.revision === current.revision && value.modelsKey === current.modelsKey)) {
      if (liveSame) return
      const changed = computeChanged(current)
      if (Object.keys(changed).length > 0 && current.ready) roster.set({ ...current, ...changed })
      return
    }
    const { state: hydrated, incomplete } = await avatarRefs.hydrate(value)
    if (order < applied) return
    avatarIncomplete = incomplete
    const latest = roster.getSnapshot()
    const sameState = hydrated.revision === latest.revision && hydrated.modelsKey === latest.modelsKey && latest.ready
    const avatarsChanged = sameState && (
      (hydrated.bots ?? []).some(bot => bot?.avatar?.image !== latest.byId?.[bot.id]?.avatar?.image)
      || (hydrated.rooms ?? []).some(room => room?.avatar?.image !== latest.roomsById?.[room.id]?.avatar?.image)
    )
    if (sameState && !avatarsChanged) {
      if (liveSame) return
      const changed = computeChanged(latest)
      if (Object.keys(changed).length > 0) roster.set({ ...latest, ...changed })
      return
    }
    // In a window with no visit record yet, everything already there counts as seen.
    if (Object.keys(seenAt).length === 0) leaveVisits([...(hydrated.bots ?? []), ...(hydrated.rooms ?? [])].map(entry => entry.id))
    const indexed = indexRoster({ ...hydrated, sections: foldWrites.reconcile(hydrated.sections, hydrated.revision) })
    if (latest.ready) {
      const gone = [
        ...Object.keys(latest.byId ?? {}).filter(id => indexed.byId[id] === undefined),
        ...Object.keys(latest.roomsById ?? {}).filter(id => indexed.roomsById[id] === undefined),
        ...Object.keys(latest.agentOf ?? {}).filter(id => indexed.agentOf?.[id] === undefined),
      ]
      if (gone.length > 0) {
        questionDrafts.pruneChats(gone)
        pruneDrafts(gone)
        pruneFailedSends(gone)
      }
    }
    roster.set(indexed)
    persistPrefs(indexed.prefs)
    if ((indexed.agents ?? []).some(agent => (agent.sessions?.length ?? 0) > 0)) {
      void refreshClassicSessions()
    }
    // Follow a Bot or group chat onto its new segment when context rolls over or moves to background.
    // On first load in Bot mode, land on the Main Bot in the same tick as `roster.set` so the
    // team window paints the chat immediately instead of sitting 400 ms on a blank main area.
    const open = shown.getSnapshot()
    if (open) {
      const target = indexed.byId[open] ?? indexed.roomsById[open]
      const nextPart = target ? currentPart(target) : open
      if (nextPart && nextPart !== open) show(nextPart)
    } else if (surface.getSnapshot().mode === 'agent') {
      const firstAgent = (indexed.agents ?? [])[0]
      const latest = firstAgent ? (latestAgentSession(firstAgent.id) ?? firstAgent.sessions?.[0]) : undefined
      if (latest) show(latest)
    } else {
      const target = indexed.mainBotId ?? indexed.bots?.[0]?.id
      if (target) show(partFor(target))
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

  const panelFolded = (view) => {
    const state = ui.getSnapshot()
    const rawViewport = typeof window === 'undefined' ? 1280 : window.innerWidth
    const isNarrow = rawViewport <= 768
    const lay = layout.getSnapshot()
    const effectiveSideW = isNarrow
      ? Math.min(lay.width, Math.max(264, Math.round(rawViewport * 0.84)))
      : Math.min(lay.width, Math.max(264, rawViewport - 420))
    const viewport = isNarrow ? Math.min(rawViewport, 680) : rawViewport
    const pref = isNarrow ? (state.leftDrawer ? 'open' : 'hidden') : lay.pref
    return frameLayout({
      viewport,
      sidebarWidth: effectiveSideW,
      pref,
      drawer: state.leftDrawer === true,
      panel: { view: view ?? state.view, yielded: state.panelYield === true },
    }).panel === 'folded'
  }

  const accountBridge = createDesktopAccountBridge({
    call,
    after,
    work,
    refreshModels: () => pull().catch(() => {}),
  })
  const appUpdates = globalThis.dshDesktop?.protocolVersion === 1 ? globalThis.dshDesktop.updates ?? null : null
  const questionDrafts = createQuestionDrafts()
  const baseActions = teamActions({ call, after, partFor, roster, ui, live, cards, heldCards, turnClock, panelFolded, questionDrafts, foldWrites })
  const speechCall = (endpoint, payload, signal) => call(endpoint, payload, signal).then(
    value => ({ ok: true, value }),
    error => ({ ok: false, error: { code: error?.code ?? 'speech/error', message: error?.message ?? String(error) } }),
  )
  const speechClient = {
    catalog: () => speechCall('speech-catalog', {}),
    configure: patch => speechCall('speech-configure', patch ?? {}),
    prepare: (providerId, options) => speechCall('speech-prepare', { providerId, ...(options === undefined ? {} : { options }) }),
    cancelPreparation: providerId => speechCall('speech-cancel', { providerId }),
    transcribe: (request, signal) => speechCall('speech-transcribe', request ?? {}, signal),
  }
  const clearShortcuts = () => ui.set(state => (state.shortcuts ? { ...state, shortcuts: false } : state))

  // Unified right sidebar workspace state: coexists with Bot/Group details, browser, side
  // chats, and tasks inside one shared `BotPanel` strip.
  const EMPTY_RIGHT_PANEL = { tabs: [], tab: 'files', file: null, fileLine: null, fileSessionId: null, fileRoot: null, revealDir: null, revealNonce: 0, changes: null, terminalNonce: 0 }
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
      || prev.fileLine !== null
      || prev.fileSessionId !== null
      || prev.fileRoot !== null
      || prev.revealDir !== null
      || prev.changes !== null
    if (!changed) return prev
    return {
      ...normalized,
      tabs: keptTabs,
      tab: nextTab,
      file: null,
      fileLine: null,
      fileSessionId: null,
      fileRoot: null,
      revealDir: null,
      changes: null,
    }
  }
  const openTurnOf = (sessionId) => {
    const facts = turnFactsBySession.get(sessionId)
    if (!facts?.turns || facts.turns.size === 0) return undefined
    let active
    for (const entry of facts.turns.values()) {
      if (Number.isInteger(entry?.turn) && entry.turn >= 0 && entry.status !== 'closed') {
        if (active === undefined || entry.turn > active) active = entry.turn
      }
    }
    return active
  }

  const appendTurnOutline = (row, { kind, text, turn, seq = null }) => {
    const prev = Array.isArray(row.projectionValues?.turnOutline) ? row.projectionValues.turnOutline : []
    const outline = prev.map(entry => ({ ...entry }))
    const field = kind === 'bot' ? 'response' : 'prompt'
    const joinText = (existing, nextText, sameSeq) => (
      kind === 'bot' && sameSeq && typeof existing === 'string' && existing !== ''
        ? `${existing}\n\n${nextText}`
        : nextText
    )
    let effectiveTurn
    if (Number.isInteger(turn) && turn >= 0) {
      effectiveTurn = turn
      const idx = outline.findIndex(entry => entry.turn === turn)
      if (idx >= 0) {
        const current = outline[idx]
        const sameSeq = Number.isInteger(seq) && current.seq === seq
        outline[idx] = {
          ...current,
          [field]: joinText(current[field], text, sameSeq),
          ...(Number.isInteger(seq) ? { seq } : {}),
          _synthetic: false,
        }
      } else {
        outline.push({ turn, [field]: text, ...(Number.isInteger(seq) ? { seq } : {}) })
        outline.sort((a, b) => (a.turn ?? 0) - (b.turn ?? 0))
      }
    } else {
      const last = outline.at(-1)
      const sameSeqBot = kind === 'bot' && last && Number.isInteger(seq) && last.seq === seq
      if (sameSeqBot) {
        effectiveTurn = last.turn
        outline[outline.length - 1] = {
          ...last,
          response: joinText(last.response, text, true),
        }
      } else if (kind === 'bot' && last && Number.isInteger(last.turn) && last.turn >= 0 && !last.response) {
        effectiveTurn = last.turn
        outline[outline.length - 1] = {
          ...last,
          response: text,
          ...(Number.isInteger(seq) ? { seq } : {}),
        }
      } else {
        const maxTurn = outline.reduce((max, entry) => (Number.isInteger(entry.turn) && entry.turn > max ? entry.turn : max), -1)
        effectiveTurn = maxTurn + 1
        outline.push({
          turn: effectiveTurn,
          [field]: text,
          ...(Number.isInteger(seq) ? { seq } : {}),
          _synthetic: true,
        })
      }
    }
    return { outline, turn: effectiveTurn }
  }

  const recordClosingReply = (sessionId, turn, text, seq = null) => {
    if (!sessionId || !Number.isInteger(turn) || turn < 0 || typeof text !== 'string' || text === '') return
    let map = closingRepliesBySession.get(sessionId)
    if (!map) { map = new Map(); closingRepliesBySession.set(sessionId, map) }
    const prev = map.get(turn)
    if (prev && seq !== null && prev.seq === seq) {
      map.set(turn, { text: `${prev.text}\n\n${text}`, seq })
    } else {
      map.set(turn, { text, seq })
    }
    notifyTurnWatchers(sessionId)
  }

  const outlineReconcileListeners = new Set()
  const notifyOutlineReconciled = (sessionId, maxTurn) => {
    for (const listener of outlineReconcileListeners) {
      try { listener(sessionId, maxTurn) } catch {}
    }
  }
  // Per-session monotonic `(seq, block)` watermark for live feed `message` items:
  // O(1) state per session with no eviction cap, preserving identical text blocks
  // within the same `seq` while skipping any replayed `(seq, block) <= watermark`.
  const lastFeedMessageCursor = new Map()
  const advanceFeedMessageCursor = (sessionId, seq, block) => {
    if (!sessionId || !Number.isInteger(seq)) return false
    const ordinal = Number.isInteger(block) && block >= 0 ? block : 0
    const prev = lastFeedMessageCursor.get(sessionId)
    if (prev !== undefined && (seq < prev.seq || (seq === prev.seq && ordinal <= prev.block))) {
      return true
    }
    lastFeedMessageCursor.set(sessionId, { seq, block: ordinal })
    return false
  }
  const maxCoveredSeqOf = (sessionId) => {
    const facts = turnFactsBySession.get(sessionId)
    if (!facts?.turns || facts.turns.size === 0) return -1
    let maxSeq = -1
    for (const entry of facts.turns.values()) {
      if (Number.isInteger(entry?.end?.seq) && entry.end.seq > maxSeq) maxSeq = entry.end.seq
      if (Number.isInteger(entry?.start?.seq) && entry.start.seq > maxSeq) maxSeq = entry.start.seq
    }
    return maxSeq
  }

  // Sent-confirmation tracking is decoupled from feed replay / outline deduplication:
  // each confirmed user message (from either transcript facts or the live feed) clears
  // at most one matching pending submission, never hangs when history arrives first,
  // and never double-pops a later pending submission on duplicate/replayed confirmations.
  const MAX_CONFIRMED_USERS = 512
  const confirmedUsersBySession = new Map()
  const evictedConfirmedSeqBySession = new Map()
  const maxConfirmedUserSeqBySession = new Map()
  const pendingSentMeta = new WeakMap()

  const confirmedUserKey = (msg) => {
    if (Number.isInteger(msg?.seq)) return `seq:${msg.seq}`
    if (msg?.id !== undefined && msg.id !== null && msg.id !== '') return `id:${msg.id}`
    if (Number.isFinite(msg?.time)) return `time:${msg.time}:${typeof msg.text === 'string' ? msg.text : ''}`
    return null
  }

  const recordConfirmedUser = (sessionId, msg) => {
    const key = confirmedUserKey(msg)
    const hasSeq = Number.isInteger(msg?.seq)
    if (key !== null) {
      const evictedMax = evictedConfirmedSeqBySession.get(sessionId) ?? -1
      if (hasSeq && msg.seq <= evictedMax) return false
      let seen = confirmedUsersBySession.get(sessionId)
      if (!seen) { seen = new Set(); confirmedUsersBySession.set(sessionId, seen) }
      if (seen.has(key)) return false
      seen.add(key)
      while (seen.size > MAX_CONFIRMED_USERS) {
        const oldest = seen.values().next().value
        seen.delete(oldest)
        if (typeof oldest === 'string' && oldest.startsWith('seq:')) {
          const oldSeq = Number(oldest.slice(4))
          if (Number.isInteger(oldSeq) && oldSeq > (evictedConfirmedSeqBySession.get(sessionId) ?? -1)) {
            evictedConfirmedSeqBySession.set(sessionId, oldSeq)
          }
        }
      }
    }
    if (hasSeq) {
      const prevMax = maxConfirmedUserSeqBySession.get(sessionId) ?? -1
      if (msg.seq > prevMax) maxConfirmedUserSeqBySession.set(sessionId, msg.seq)
    }
    return true
  }

  const textMatchesPending = (pendingText, msgText) => (
    pendingText === msgText || pendingText.trim() === msgText.trim()
  )

  const findPendingMatchIndex = (queue, msg, source) => {
    const hasSeq = Number.isInteger(msg?.seq)
    const hasMsgText = typeof msg?.text === 'string'
    const hasMsgTime = Number.isFinite(msg?.time)
    const isEligible = (entry) => {
      const meta = pendingSentMeta.get(entry)
      if (hasSeq && Number.isInteger(meta?.afterSeq) && meta.afterSeq >= 0 && msg.seq <= meta.afterSeq) {
        return false
      }
      if (source === 'facts' && meta?.hasExplicitTime && hasMsgTime && msg.time < entry.time - 2000) {
        return false
      }
      return true
    }
    if (hasMsgText) {
      for (let i = 0; i < queue.length; i += 1) {
        const entry = queue[i]
        if (typeof entry.text === 'string' && isEligible(entry) && textMatchesPending(entry.text, msg.text)) {
          return i
        }
      }
      for (let i = 0; i < queue.length; i += 1) {
        const entry = queue[i]
        if (entry.text === undefined && isEligible(entry)) {
          return i
        }
      }
      return -1
    }
    for (let i = 0; i < queue.length; i += 1) {
      if (isEligible(queue[i])) return i
    }
    return -1
  }

  const confirmUserMessage = (sessionId, msg, { source = 'feed' } = {}) => {
    if (!sessionId || !msg) return
    if (!recordConfirmedUser(sessionId, msg)) return
    sent.set((state) => {
      const queue = state[sessionId]
      if (!queue?.length) return state
      const index = findPendingMatchIndex(queue, msg, source)
      if (index < 0) return state
      if (queue.length === 1) {
        const next = { ...state }
        delete next[sessionId]
        return next
      }
      return { ...state, [sessionId]: [...queue.slice(0, index), ...queue.slice(index + 1)] }
    })
  }

  const syncOutlineFromFacts = (sessionId, facts) => {
    if (!facts?.turns || facts.turns.size === 0) return
    const closedReplies = facts.closingReplies
    const ordered = [...facts.turns.values()]
      .filter(entry => Number.isInteger(entry.turn) && entry.turn >= 0)
      .sort((a, b) => a.turn - b.turn)
    if (ordered.length === 0) return
    let prunedSynthetic = false
    let reconciledMaxTurn = ordered[ordered.length - 1].turn
    sessions.set((list) => {
      const row = list.byId[sessionId] ?? { id: sessionId }
      const prev = Array.isArray(row.projectionValues?.turnOutline) ? row.projectionValues.turnOutline : []
      const canonicalTurns = new Set(ordered.map(entry => entry.turn))
      const byTurn = new Map()
      let droppedSynthetic = false
      for (const item of prev) {
        if (!Number.isInteger(item?.turn) || item.turn < 0) continue
        if (item._synthetic && !canonicalTurns.has(item.turn)) {
          droppedSynthetic = true
          continue
        }
        byTurn.set(item.turn, { ...item })
      }
      if (droppedSynthetic) prunedSynthetic = true
      let changed = droppedSynthetic
      for (const entry of ordered) {
        const hasReply = Boolean(closedReplies?.has(entry.turn))
        const reply = hasReply ? closedReplies.get(entry.turn) : undefined
        const existing = byTurn.get(entry.turn)
        if (!existing) {
          byTurn.set(entry.turn, reply ? { turn: entry.turn, response: reply } : { turn: entry.turn })
          changed = true
        } else {
          const nextEntry = { ...existing }
          let updated = false
          if (nextEntry._synthetic) {
            delete nextEntry._synthetic
            updated = true
          }
          if (hasReply && nextEntry.response !== reply) {
            if (reply) nextEntry.response = reply
            else delete nextEntry.response
            updated = true
          }
          if (updated) {
            byTurn.set(entry.turn, nextEntry)
            changed = true
          }
        }
      }
      const needReplyCount = typeof row.replyCount !== 'number'
      if (!changed && !needReplyCount) return list
      const nextOutline = [...byTurn.values()].sort((a, b) => a.turn - b.turn)
      if (nextOutline.length > 0) reconciledMaxTurn = nextOutline[nextOutline.length - 1].turn
      return {
        ids: list.ids.includes(sessionId) ? list.ids : [...list.ids, sessionId],
        byId: {
          ...list.byId,
          [sessionId]: {
            ...row,
            replyCount: row.replyCount ?? 0,
            projectionValues: { ...(row.projectionValues ?? {}), turnOutline: nextOutline },
          },
        },
      }
    })
    if (prunedSynthetic) {
      notifyOutlineReconciled(sessionId, reconciledMaxTurn)
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
      ui.set(state => (state.rightPanel !== null || state.panelYield ? { ...state, rightPanel: null, panelYield: false } : state))
    },
    closeOverlay: () => {
      const hadDialog = Boolean(ui.getSnapshot().newChat || ui.getSnapshot().exchange)
      baseActions.closeOverlay()
      if (!hadDialog) {
        ui.set(state => (state.details === null && (state.rightPanel !== null || state.panelYield) ? { ...state, rightPanel: null, panelYield: false } : state))
      }
    },
    toggleDetails: (id, force) => {
      baseActions.toggleDetails(id, force)
      ui.set(state => (state.details === null && (state.rightPanel !== null || state.panelYield) ? { ...state, rightPanel: null, panelYield: false } : state))
    },
    openSettings: (...args) => { clearShortcuts(); return baseActions.openSettings(...args) },
    selectPanel: (id) => {
      if (typeof id !== 'string' || id === '') return
      if (id === 'files' || id === 'terminal' || id === 'preview' || id === 'changes') {
        openWorkspaceTab(id)
        return
      }
      if (
        id === 'overview' || id === 'general' || id === 'shortcuts' || id === 'appearance'
        || id === 'models' || id === 'local-agents' || id === 'bot-models' || id === 'deepseek-services'
        || id === 'bots' || id === 'groups' || id === 'schedules'
        || id === 'connectors' || id === 'im' || id === 'phone' || id === 'api'
        || id === 'computer' || id === 'browser' || id === 'capabilities' || id === 'secrets'
        || id === 'plugins' || id === 'usage' || id === 'about' || id === 'privacy' || id === 'feedback'
      ) {
        actions.openSettings(id)
        return
      }
      actions.openSettings('overview')
    },
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
        panelYield: false,
        rightPanel: null,
        newChat: null,
        inbox: false,
        exchange: null,
        menu: null,
        palette: null,
        groupSearch: null,
        settings: null,
        releaseNotes: null,
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
    openSession: (id, message) => {
      if (isAgentSessionId(id)) {
        actions.openAgentSession(id)
        return
      }
      navSeq += 1
      if (surface.getSnapshot().mode === 'agent') {
        writeMode('bot')
        surface.set({ mode: 'bot' })
      }
      lastTeamSession = id
      const next = partFor(id)
      const switched = next !== shown.getSnapshot()
      const fromInbox = ui.getSnapshot().inbox === true
      show(next)
      ui.set((state) => {
        const messageJump = next === id ? messageJumpTarget(id, message) : null
        const dropOverlay = Boolean(state.newChat || state.exchange || state.menu || state.palette || state.shortcuts || state.inbox || state.inboxTarget || state.pendingOpen)
        const rp = switched ? pruneStaleWorkspace(state.rightPanel) : state.rightPanel
        const foldWorkspace = switched && state.view === 'workspace' && rp === null
        if (!dropOverlay && rp === state.rightPanel && !foldWorkspace && !messageJump && !state.messageJump) return state
        return {
          ...state,
          messageJump,
          ...(dropOverlay ? { newChat: null, exchange: null, menu: null, palette: null, shortcuts: false, inbox: false, inboxTarget: fromInbox ? next : null, pendingOpen: null } : {}),
          ...(foldWorkspace ? { view: 'details' } : {}),
          rightPanel: rp,
        }
      })
    },
    finishMessageJump,
    retryOpening: (target) => {
      if (!target) return
      actions.openSession(target)
    },
    recoverOpening: async (botId) => {
      if (!botId || recovering.has(botId)) return
      recovering.add(botId)
      const seq = ++navSeq
      try {
        await after(call('recover-session', { botId }))
        if (seq !== navSeq) return
        const bot = roster.getSnapshot().byId?.[botId]
        if (bot === undefined) {
          ui.set(state => (state.pendingOpen === null ? state : { ...state, pendingOpen: null }))
          return
        }
        actions.openSession(currentPart(bot))
      } catch (error) {
        actions.reportError?.(error, 'reopen-session')
      } finally {
        recovering.delete(botId)
      }
    },
    openAgentSession: (sessionId) => {
      if (!sessionId) return
      navSeq += 1
      const switched = sessionId !== shown.getSnapshot()
      const fromInbox = ui.getSnapshot().inbox === true
      lastAgentSession = sessionId
      const hasClassicBrowser = Boolean(
        roster.getSnapshot().browser === true
        && browsers
        && (browsers.tabs.getSnapshot()[CLASSIC_BROWSER_OWNER]?.ids?.length ?? 0) > 0,
      )
      show(sessionId)
      ui.set((state) => {
        const rp = switched ? pruneStaleWorkspace(state.rightPanel) : state.rightPanel
        const hasWorkspace = rp !== null && rp.tabs.length > 0
        const keepBrowser = Boolean(state.details && state.view === 'browser' && hasClassicBrowser)
        const keepWorkspace = Boolean(state.details && hasWorkspace)
        const keepPanel = keepBrowser || keepWorkspace
        return {
          ...state,
          ...(keepPanel
            ? {
                details: sessionId,
                view: keepBrowser ? 'browser' : 'workspace',
                renaming: false,
                tab: null,
                side: null,
                task: null,
              }
            : { details: null, view: 'details', renaming: false, tab: null, side: null, task: null, panelYield: false }),
          newChat: null,
          exchange: null,
          menu: null,
          palette: null,
          groupSearch: null,
          shortcuts: false,
          inbox: false,
          inboxTarget: fromInbox ? sessionId : null,
          pendingOpen: null,
          rightPanel: keepWorkspace ? rp : null,
        }
      })
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
      pruneDrafts([sessionId])
      pruneFailedSends([sessionId])
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
      if (owned.length > 0) {
        pruneDrafts(owned)
        pruneFailedSends(owned)
      }
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
    sessionControls: sessionId => call('session-controls', { sessionId }),
    selectSessionModel: (sessionId, ref, effort) => after(call('session-model', {
      sessionId,
      ...(ref !== undefined ? { ref } : {}),
      ...(effort !== undefined ? { effort } : {}),
    })),
    setSessionPermission: (sessionId, preset) => after(call('session-permission', { sessionId, preset })),
    sessionCommands: (sessionId, options) => call('session-commands', {
      sessionId,
      ...(options?.wake ? { wake: true } : {}),
    }),
    runSessionCommand: (sessionId, line, extra) => after(call('session-command-run', {
      sessionId,
      line,
      ...(extra?.images?.length ? { images: extra.images } : {}),
      ...(extra?.files?.length ? { files: extra.files } : {}),
    })),
    sessionSkills: sessionId => call('session-skills', { sessionId }),
    sessionFiles: (sessionId, query = '') => call('session-files', { sessionId, query }),
    answerUserQuestion: (sessionId, requestId, answers) => after(call('session-question-answer', { sessionId, requestId, answers })),
    dismissUserQuestion: (sessionId, requestId) => after(call('session-question-dismiss', { sessionId, requestId })),
    updateSessionQueue: (sessionId, itemId, action) => after(call('session-queue-update', { sessionId, itemId, action })),
    steerSessionQueue: (sessionId, itemIds) => after(call('session-queue-update', {
      sessionId,
      ...(Array.isArray(itemIds) && itemIds.length > 0 ? { itemIds } : {}),
      action: { kind: 'steer-all' },
    })),
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
    navSeq: () => navSeq,
    landOn: (id, last, expectedSeq) => {
      if (expectedSeq !== undefined && expectedSeq !== navSeq) return undefined
      const seq = ++navSeq
      if (!last) {
        show(partFor(id))
        return undefined
      }
      const currentOfLast = (snap) => {
        const bot = last.kind === 'room' ? undefined : snap.byId?.[last.botId ?? last.id]
        if (bot !== undefined) return currentPart(bot)
        const room = snap.roomsById?.[last.roomId ?? last.id]
        return room === undefined ? undefined : (room.sessionId ?? room.id)
      }
      return (async () => {
        let moved = currentOfLast(roster.getSnapshot())
        if (moved === undefined || moved === last.sessionId) {
          await pull().catch(() => {})
          if (seq !== navSeq) return
          moved = currentOfLast(roster.getSnapshot())
        }
        if (seq !== navSeq) return
        const target = moved !== undefined && moved !== last.sessionId ? moved : partFor(id)
        if (target) show(target)
      })()
    },
    steerQueued: async (sessionId) => {
      if (!sessionId) return
      const rows = sessionQueues.getSnapshot()[sessionId] ?? []
      const ids = rows
        .filter(row => typeof row?.id === 'string' && row.id !== '' && row?.source?.kind === 'user')
        .map(row => row.id)
      if (ids.length === 0) return
      try {
        if (roster.getSnapshot().byId?.[sessionId] !== undefined && typeof actions.steerQueueBatch === 'function') {
          try {
            const result = await actions.steerQueueBatch(sessionId, ids)
            if (result?.fallback !== true) return
          } catch (error) {
            if (error?.code !== 'bot/not-found') throw error
          }
        }
        await actions.steerSessionQueue(sessionId, ids)
      } catch {
        actions.reportError?.(new Error(t('Couldn’t steer the queued messages. Try again.')), 'steer-queue')
      }
    },
    draftFiles: (ids) => {
      if (!Array.isArray(ids) || ids.length === 0) return []
      const out = []
      for (const id of ids) {
        const entry = draftFileStore.get(id)
        if (entry) out.push({ kind: entry.kind, file: entry.file })
      }
      return out
    },
    restoreDraftFiles: (sessionId, files) => {
      if (!Array.isArray(files) || files.length === 0) return []
      const ids = []
      for (const item of files) {
        if (!item || typeof item !== 'object') continue
        const isWrapper = item.file && typeof item.file === 'object'
        const file = isWrapper ? item.file : item
        if (typeof file.name !== 'string' && typeof file.size !== 'number' && typeof file.type !== 'string') continue
        const mime = typeof file.type === 'string' ? file.type : ''
        const kind = isWrapper && typeof item.kind === 'string'
          ? item.kind
          : (mime.startsWith('image/') ? 'image' : 'file')
        const id = `draft-file-${++draftFileSeq}`
        draftFileStore.set(id, { sessionId: sessionId ?? null, kind, file })
        ids.push(id)
      }
      return ids
    },
    releaseDraftFiles: (ids) => {
      if (!Array.isArray(ids)) return
      for (const id of ids) draftFileStore.delete(id)
    },
    holdSettingsLook: () => () => {},
    watchAgentTerminals: sessionId => watchAgentTerminals(slots, sessionId, error => actions.reportError?.(error, 'right-sidebar')),
    signInEntry: () => accountBridge.signInEntry(),
    canSignIn: () => accountBridge.canSignIn(),
    signIn: () => ui.set(state => ({ ...state, signIn: (state.signIn ?? 0) + 1 })),
    closeSignIn: () => ui.set(state => ({ ...state, signIn: null })),
    accountT: () => accountBridge.accountT(),
    setSidebarPref: (pref) => {
      const next = pref === 'rail' || pref === 'hidden' ? pref : 'open'
      const nextShown = next === 'hidden' ? sidebarSaved.shown : next
      if (sidebarSaved.pref === next && sidebarSaved.shown === nextShown) return
      sidebarSaved = { ...sidebarSaved, pref: next, shown: nextShown }
      writeSidebar(sidebarSaved)
      layout.set({ ...sidebarSaved, wide: next === 'open' })
    },
    setSidebarWidth: (width) => {
      if (!Number.isFinite(width)) return
      const clamped = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(width)))
      if (sidebarSaved.width === clamped) return
      sidebarSaved = { ...sidebarSaved, width: clamped }
      writeSidebar(sidebarSaved)
      layout.set(state => (state.width === clamped ? state : { ...sidebarSaved, wide: state.pref === 'open' }))
    },
    toggleLeftHidden: () => {
      ui.set(state => (state.leftDrawer ? { ...state, leftDrawer: false } : state))
      actions.setSidebarPref(toggledPref(layout.getSnapshot().pref, sidebarSaved.shown))
    },
    setLeftDrawer: on => ui.set(state => (state.leftDrawer === Boolean(on) ? state : { ...state, leftDrawer: Boolean(on) })),
    setPanelYield: on => ui.set(state => (state.panelYield === Boolean(on) ? state : { ...state, panelYield: Boolean(on) })),
    toggleSidebar: () => actions.toggleLeftHidden(),
    setSidebarWide: next => actions.setSidebarPref(next ? 'open' : 'hidden'),
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
    revealFolder: (input) => {
      const raw = typeof input === 'string' ? input : (typeof input?.path === 'string' ? input.path : '')
      const target = raw.replace(/[\\/]+$/, '')
      const revealSessionId = typeof input?.sessionId === 'string' && input.sessionId !== '' ? input.sessionId : null
      openWorkspaceTab('files', prev => ({
        ...prev,
        revealDir: target,
        revealNonce: (prev?.revealNonce ?? 0) + 1,
      }), revealSessionId)
    },
    openFile: (path) => {
      const target = typeof path === 'string' ? path : (typeof path?.path === 'string' ? path.path : '')
      if (target === '') return
      const fileSessionId = typeof path?.sessionId === 'string' && path.sessionId !== '' ? path.sessionId : null
      const isDir = path?.isDir === true || (/[\\/]$/.test(target) && target !== '/' && !/^[A-Za-z]:[\\/]$/.test(target))
      if (isDir) {
        actions.revealFolder({ path: target, sessionId: fileSessionId })
        return
      }
      const fileRoot = typeof path?.root === 'string' && path.root !== '' ? path.root : null
      const fileLine = Number.isInteger(path?.line) && path.line > 0 ? path.line : null
      const fileFallback = typeof path?.onUnavailable === 'function' ? path.onUnavailable : null
      openWorkspaceTab('preview', prev => ({ ...prev, file: target, fileLine, fileSessionId, fileRoot, fileFallback }), fileSessionId)
    },
    openChanges: async (changes) => {
      if (!changes || typeof changes !== 'object' || typeof changes.sessionId !== 'string' || !Number.isInteger(changes.seq)) return
      let available = false
      try { available = (await call('changes-check', { sessionId: changes.sessionId, seq: changes.seq })) === true } catch { available = false }
      if (!available) { actions.notice?.(t('These changes are no longer available')); return }
      openWorkspaceTab('changes', prev => ({ ...prev, changes }), changes.sessionId)
    },
    newTerminal: () => openWorkspaceTab('terminal', prev => ({ ...prev, terminalNonce: ++terminalNonceSeq })),
    consumeTerminalNonce: (nonce) => {
      if (!nonce) return
      ui.set((state) => {
        if (!state.rightPanel || state.rightPanel.terminalNonce !== nonce) return state
        return { ...state, rightPanel: { ...state.rightPanel, terminalNonce: 0 } }
      })
    },
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
              ...(tabId === 'preview' ? { file: null, fileLine: null, fileSessionId: null, fileRoot: null, fileFallback: null } : {}),
              ...(tabId === 'changes' ? { changes: null } : {}),
              ...(tabId === 'terminal' ? { terminalNonce: 0 } : {}),
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
        if (surface.getSnapshot().mode === 'agent'
          && snap.browser === true
          && browsers
          && (browsers.tabs.getSnapshot()[CLASSIC_BROWSER_OWNER]?.ids?.length ?? 0) > 0) {
          return {
            ...state,
            rightPanel: null,
            view: 'browser',
            renaming: false,
            tab: null,
            side: null,
            task: null,
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
          panelYield: false,
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
    speech: () => (roster.getSnapshot().speech === true ? speechClient : undefined),
    hasPluginMic: () => false,
    voiceSetup: (providerId) => (roster.getSnapshot().speech === true && providerId !== undefined
      ? { prepare: () => requestPreparation(speechClient, providerId) }
      : null),
    noteTurnFacts: (sessionId, facts) => {
      if (!sessionId) return
      if (!facts) {
        if (!turnFactsBySession.has(sessionId)) return
        turnFactsBySession.delete(sessionId)
      } else {
        turnFactsBySession.set(sessionId, facts)
        syncOutlineFromFacts(sessionId, facts)
        if (Array.isArray(facts.userMessages)) {
          for (const msg of facts.userMessages) {
            confirmUserMessage(sessionId, msg, { source: 'facts' })
          }
        }
      }
      notifyTurnWatchers(sessionId)
    },
    closingReply: (sessionId, turn) => {
      if (!sessionId || !Number.isInteger(turn) || turn < 0) return null
      const facts = turnFactsBySession.get(sessionId)
      const turnFact = facts?.turns?.get(turn)
      if (turnFact && turnFact.status !== 'closed') return undefined
      const fromFacts = facts?.closingReplies?.get(turn)
      if (typeof fromFacts === 'string' && fromFacts !== '') return fromFacts
      if (turnFact?.status === 'closed') return ''
      const fromFeed = closingRepliesBySession.get(sessionId)?.get(turn)?.text
      if (typeof fromFeed === 'string' && fromFeed !== '') return fromFeed
      const row = sessions.getSnapshot().byId?.[sessionId]
      const outline = row?.projectionValues?.turnOutline
      if (Array.isArray(outline)) {
        const entry = outline.find(item => item?.turn === turn)
        if (typeof entry?.response === 'string' && entry.response !== '') return entry.response
      }
      const snap = roster.getSnapshot()
      const known = row !== undefined || snap.byId?.[sessionId] !== undefined || snap.roomsById?.[sessionId] !== undefined
      return known ? undefined : null
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
    noteSent: (sessionId, meta) => {
      if (!sessionId) return () => {}
      const hasExplicitTime = Number.isFinite(meta?.time)
      const entry = {
        placement: typeof meta?.placement === 'string' ? meta.placement : 'direct',
        time: hasExplicitTime ? meta.time : Date.now(),
        ...(typeof meta?.requestId === 'string' && meta.requestId !== '' ? { requestId: meta.requestId } : {}),
        ...(typeof meta?.text === 'string' ? { text: meta.text } : {}),
      }
      const afterSeq = Math.max(maxCoveredSeqOf(sessionId), maxConfirmedUserSeqBySession.get(sessionId) ?? -1)
      pendingSentMeta.set(entry, { afterSeq, hasExplicitTime })
      sent.set(state => ({ ...state, [sessionId]: [...(state[sessionId] ?? EMPTY_PENDING), entry] }))
      return () => {
        sent.set((state) => {
          const queue = state[sessionId]
          if (!queue?.length) return state
          const index = queue.indexOf(entry)
          if (index < 0) return state
          if (queue.length === 1) {
            const next = { ...state }
            delete next[sessionId]
            return next
          }
          return { ...state, [sessionId]: [...queue.slice(0, index), ...queue.slice(index + 1)] }
        })
      }
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
    openAppUpdates: async (verified) => {
      if (!appUpdates?.status) return
      const app = await appUpdates.status()
      if (app) update.set(previous => ({ ...previous, app }))
      if (sameVersion(app?.version, verified)) await appUpdates.open?.()
    },
    checkOwnApp: async () => { await globalThis.dsBotApp?.updates?.check?.() },
    installOwnApp: async () => { await globalThis.dsBotApp?.updates?.install?.() },
    openOwnApp: async () => { await globalThis.dsBotApp?.updates?.open?.() },
    downloadOwnApp: async () => { await globalThis.dsBotApp?.updates?.download?.() },
    setOwnAppAutoUpdate: async (enabled) => { await globalThis.dsBotApp?.updates?.setAutoUpdate?.(enabled === true) },
    noteReplyArrival: (sessionId, delta) => {
      if (!sessionId || !Number.isFinite(delta) || delta <= 0) return
      editRow(sessionId, (row) => {
        const base = typeof row.replyCount === 'number'
          ? row.replyCount
          : (Array.isArray(row.projectionValues?.turnOutline)
            ? row.projectionValues.turnOutline.reduce((count, entry) => count + (entry?.response ? 1 : 0), 0)
            : 0)
        return { ...row, replyCount: base + delta }
      })
    },
    reconnectFeed: () => { restartFeed() },
  }

  // Without the Desktop bridge these stay undefined, and no browser control renders.
  // Classic mode shares the same browser view plumbing under a dedicated owner key.
  const resolveBrowserOwner = (id) => {
    const snap = roster.getSnapshot()
    const bot = id ? snap.byId?.[id] : undefined
    if (bot) return { ownerId: bot.id, detailsId: id, isClassic: false }
    if (id === CLASSIC_BROWSER_OWNER || surface.getSnapshot().mode === 'agent') {
      return { ownerId: CLASSIC_BROWSER_OWNER, detailsId: shown.getSnapshot() || CLASSIC_BROWSER_OWNER, isClassic: true }
    }
    return null
  }
  if (browsers) {
    Object.assign(actions, {
      // The globe / `+ -> Browser` trigger: the active browser tab (Bot or Classic), or a new tab.
      openBrowser: (id) => {
        const target = resolveBrowserOwner(id)
        if (!target) return
        browsers.ensureTabs(target.ownerId)
        if (browsers.tabs.getSnapshot()[target.ownerId]?.active == null) browsers.openTab(target.ownerId)
        ui.set(state => ({ ...state, inbox: false, details: target.detailsId, view: 'browser', renaming: false, tab: null, panelYield: true }))
      },
      toggleBrowser: (id) => {
        const snap = roster.getSnapshot()
        if (snap.browser === false) return
        const target = resolveBrowserOwner(id)
        if (!target) return
        const state = ui.getSnapshot()
        const sameOwner = target.isClassic
          ? (!snap.byId?.[state.details] && !snap.roomsById?.[state.details])
          : ((snap.byId?.[state.details]?.id ?? state.details) === target.ownerId)
        if (state.details && state.view === 'browser' && sameOwner) {
          actions.closePanel()
          return
        }
        actions.openBrowser(target.isClassic ? CLASSIC_BROWSER_OWNER : target.ownerId)
      },
      // `+` on the strip or the drawer's new-tab card: a blank tab in the browser view.
      browserNewTab: (id) => {
        const target = resolveBrowserOwner(id)
        if (!target) return null
        browsers.ensureTabs(target.ownerId)
        const tabId = browsers.openTab(target.ownerId)
        ui.set(state => ({ ...state, inbox: false, details: target.detailsId, view: 'browser', renaming: false, tab: null, panelYield: true }))
        return tabId
      },
      // A drawer card: its tab active, the panel on the browser view.
      browserPick: (id, tabId) => {
        const target = resolveBrowserOwner(id)
        if (!target) return
        browsers.activate(target.ownerId, tabId)
        ui.set(state => ({ ...state, inbox: false, details: target.detailsId, view: 'browser', renaming: false, tab: null, panelYield: true }))
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
          if (!subjectBot && botId !== CLASSIC_BROWSER_OWNER) return state
          const hasWorkspace = (state.rightPanel?.tabs?.length ?? 0) > 0
          if (hasWorkspace) return { ...state, view: 'workspace', renaming: false, tab: null }
          const hasSide = Boolean(subjectBot && state.side && (snap.sideChats?.[subjectBot.id] ?? []).some(chat => chat?.id === state.side))
          if (hasSide) return { ...state, view: 'side', renaming: false, tab: null }
          if (subjectBot || snap.roomsById?.[state.details]) return { ...state, view: 'details', renaming: false, tab: null }
          return { ...state, details: null, view: 'details', renaming: false, tab: null, side: null, task: null, panelYield: false, rightPanel: null }
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
        apply: (botId, pending, options) => bridge.importApply(
          Array.isArray(botId) ? botId.map(id => `bot:${id}`) : `bot:${botId}`,
          pending,
          options,
        ),
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
    const activeRooms = new Set(snap.activeRooms ?? [])
    for (const room of r.rooms ?? []) {
      const part = currentPart(room)
      const busy = activeRooms.has(room.id) || (rooms[room.id]?.length ?? 0) > 0
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
  const isCovered = snap => snap.inbox === true || Boolean(snap.newChat)
  let wasCovered = isCovered(ui.getSnapshot())
  ui.subscribe(() => {
    const covered = isCovered(ui.getSnapshot())
    if (wasCovered && !covered) {
      const active = shown.getSnapshot()
      if (active) setStatus(active, { completionUnread: false })
    }
    wasCovered = covered
  })

  const onFeed = (event, data) => {
    if (event === 'hello' && data?.resumed !== true) {
      for (const sessionId of streamingReply) actions.noteLive(sessionId, 'reply', null)
      streamingReply.clear()
      // Notice seq restarts from 1 on a fresh host boot; session log seq is durable.
      lastGroupNoticeSeq.clear()
    }
    if (event === 'message' && data?.sessionId && data.item) {
      const { sessionId, item } = data
      const text = item.kind === 'bot' || item.kind === 'user' ? item.text : ''
      const hasSeq = Number.isInteger(item.seq)
      const isReplay = Boolean(hasSeq && advanceFeedMessageCursor(sessionId, item.seq, item.block))
      const coveredByFacts = Boolean(
        text
        && hasSeq
        && !(Number.isInteger(item.turn) && item.turn >= 0)
        && item.seq <= maxCoveredSeqOf(sessionId),
      )
      if (item.kind === 'user') {
        confirmUserMessage(sessionId, item, { source: 'feed' })
      }
      let countReply = false
      if (item.kind === 'bot') {
        const hasFiniteSeq = Number.isFinite(item.seq)
        const prevSeq = hasFiniteSeq ? (lastFeedReplySeq.get(sessionId) ?? -1) : -1
        const seqReplay = hasFiniteSeq && item.seq <= prevSeq
        if (hasFiniteSeq && !seqReplay) lastFeedReplySeq.set(sessionId, item.seq)
        // Active DM Sessions count tail arrivals via SessionTranscript's monotonic seq watermark
        // so "Load earlier", gap fills, and replays never inflate replyCount or double-count.
        countReply = !seqReplay && !isReplay && !coveredByFacts && shown.getSnapshot() !== sessionId
      }
      if (!isReplay && !coveredByFacts) {
        if (item.kind === 'bot') {
          if (streamingReply.delete(sessionId)) actions.noteLive(sessionId, 'reply', null)
          // Set completionUnread BEFORE updating turnOutline so watchBotCompletions sees the
          // unread flag on the first turnOutline snapshot for a background Bot.
          if (shown.getSnapshot() !== sessionId || isCovered(ui.getSnapshot())) setStatus(sessionId, { completionUnread: true })
        }
        let effectiveTurn = null
        editRow(sessionId, (row) => {
          const updatedAt = Math.max(row.updatedAt ?? 0, item.time ?? 0)
          const replyPatch = countReply
            ? { replyCount: (row.replyCount ?? 0) + 1 }
            : (typeof row.replyCount === 'number' ? {} : { replyCount: 0 })
          if (!text) return { ...row, updatedAt, ...replyPatch }
          const resolvedTurn = Number.isInteger(item.turn) && item.turn >= 0 ? item.turn : openTurnOf(sessionId)
          const next = appendTurnOutline(row, {
            kind: item.kind,
            text,
            turn: resolvedTurn,
            seq: hasSeq ? item.seq : null,
          })
          effectiveTurn = next.turn
          return {
            ...row,
            updatedAt,
            ...replyPatch,
            projectionValues: { ...(row.projectionValues ?? {}), turnOutline: next.outline },
          }
        })
        if (item.kind === 'bot' && text && Number.isInteger(effectiveTurn)) {
          recordClosingReply(sessionId, effectiveTurn, text, hasSeq ? item.seq : null)
        }
      } else if (item.kind === 'bot' && streamingReply.delete(sessionId)) {
        actions.noteLive(sessionId, 'reply', null)
      }
    }
    if (event === 'notice' && data?.kind === 'group' && data.roomId) {
      const room = roster.getSnapshot().roomsById?.[data.roomId]
      const roomSession = room ? currentPart(room) : data.roomId
      const hasSeq = Number.isFinite(data.seq)
      const prevSeq = hasSeq ? (lastGroupNoticeSeq.get(roomSession) ?? -1) : -1
      const isReplay = hasSeq && data.seq <= prevSeq
      if (hasSeq && !isReplay) lastGroupNoticeSeq.set(roomSession, data.seq)
      if (!isReplay && (shown.getSnapshot() !== roomSession || isCovered(ui.getSnapshot()))) setStatus(roomSession, { completionUnread: true })
      if (data.text && !isReplay) {
        editRow(roomSession, (row) => {
          const next = appendTurnOutline(row, { kind: 'bot', text: data.text, turn: data.turn, seq: Number.isInteger(data.seq) ? data.seq : null })
          return {
            ...row,
            updatedAt: Math.max(row.updatedAt ?? 0, data.time ?? 0),
            replyCount: (row.replyCount ?? 0) + 1,
            projectionValues: { ...(row.projectionValues ?? {}), turnOutline: next.outline },
          }
        })
      }
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
    let lostTimer
    let lostSince = 0
    let closeFeed = () => {}
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
      else {
        read()
        startTimer()
      }
    }
    const clearLost = () => {
      if (lostTimer !== undefined) { clearTimeout(lostTimer); lostTimer = undefined }
      lostSince = 0
      if (connection.getSnapshot().status !== 'connected') {
        connection.set({ status: 'connected', error: null, code: null })
      }
    }
    const noteLost = () => {
      if (stopped || lostSince > 0 || connection.getSnapshot().status === 'error') return
      lostSince = Date.now()
      lostTimer = setTimeout(() => {
        lostTimer = undefined
        if (!stopped && lostSince > 0) {
          connection.set({ status: 'reconnecting', error: null, code: null })
        }
      }, RECONNECT_NOTICE_MS)
    }
    const handleFeedEvent = (event, data) => {
      if (stopped) return
      if (event === 'lost') {
        noteLost()
        onFeed(event, data)
        return
      }
      if (event === 'error' && data?.fatal === true) {
        if (lostTimer !== undefined) { clearTimeout(lostTimer); lostTimer = undefined }
        lostSince = 0
        connection.set({ status: 'error', error: data?.message ?? null, code: data?.code ?? null })
        onFeed(event, data)
        return
      }
      clearLost()
      if (event === 'revision') read()
      else if (event === 'live') {
        if (typeof document === 'undefined' || !document.hidden) read()
      } else if (event === 'hello' && data?.resumed !== true) {
        if (typeof document === 'undefined' || !document.hidden) read()
      }
      onFeed(event, data)
    }
    const connectFeed = () => {
      closeFeed()
      closeFeed = openFeed(handleFeedEvent)
    }
    restartFeed = () => {
      if (stopped) return
      if (lostTimer !== undefined) { clearTimeout(lostTimer); lostTimer = undefined }
      lostSince = Date.now()
      connection.set({ status: 'reconnecting', error: null, code: null })
      connectFeed()
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
    let unsubscribeAppUpdates = null
    if (appUpdates?.status && appUpdates.subscribe) {
      const takeApp = (app) => {
        if (!stopped && app) update.set(previous => ({ ...previous, app }))
      }
      void Promise.resolve(appUpdates.status()).then(takeApp, () => {})
      unsubscribeAppUpdates = appUpdates.subscribe(takeApp)
    }
    let unsubscribeOwnApp = null
    const ownAppUpdates = globalThis.dsBotApp?.updates ?? null
    if (ownAppUpdates?.state && ownAppUpdates.subscribe) {
      const takeOwnApp = (ownApp) => {
        if (!stopped && ownApp) update.set(previous => ({ ...previous, ownApp }))
      }
      void Promise.resolve(ownAppUpdates.state()).then(takeOwnApp, () => {})
      unsubscribeOwnApp = ownAppUpdates.subscribe(takeOwnApp)
    }
    const stopAccountExternal = accountBridge.subscribeExternal()
    void accountBridge.refresh()
    const stopBotCompletions = watchBotCompletions({
      roster,
      sessions,
      statuses: status,
      unread: botCompletions,
      ui,
      onReconcile: (listener) => {
        outlineReconcileListeners.add(listener)
        return () => { outlineReconcileListeners.delete(listener) }
      },
    })
    connectFeed()
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
        // Keep the shared Classic browser owner alive across roster updates.
        void browsers.retain([...snapshot.bots.map(bot => bot.id), CLASSIC_BROWSER_OWNER]).catch(() => {})
        // A panel open on a deleted subject or unavailable browser falls back cleanly to
        // workspace (if open), details (if subject still exists), or closes completely.
        ui.set((state) => {
          if (!state.details) return state
          const hasBot = Boolean(snapshot.byId[state.details])
          const hasRoom = Boolean(snapshot.roomsById?.[state.details])
          const hasWorkspace = (state.rightPanel?.tabs?.length ?? 0) > 0
          const isClassicBrowser = !hasBot && !hasRoom && surface.getSnapshot().mode === 'agent'
          if (state.view === 'browser') {
            if (on && (hasBot || isClassicBrowser)) return state
            if (hasWorkspace) return { ...state, view: 'workspace' }
            if (hasBot || hasRoom) return { ...state, view: 'details' }
            return { ...state, details: null, view: 'details', renaming: false, tab: null, side: null, task: null, panelYield: false, rightPanel: null }
          }
          if (!hasBot && !hasRoom && !hasWorkspace) {
            return { ...state, details: null, view: 'details', renaming: false, tab: null, side: null, task: null, panelYield: false, rightPanel: null }
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
      const nameOf = id => roster.getSnapshot().byId[id]?.name ?? t('a Bot')
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
      let pollAbort = null
      let wakeEnabled = null
      let cancelPause = null
      const abortPoll = () => {
        if (pollAbort) { const ctrl = pollAbort; pollAbort = null; ctrl.abort() }
      }
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
        else abortPoll()
      })
      const runCursor = async () => {
        let after = 0
        while (!stopped) {
          if (roster.getSnapshot().computer?.enabled !== true) { await waitEnabled(); continue }
          const ctrl = new AbortController()
          pollAbort = ctrl
          try {
            const reply = await call('computer-cursor-wait', { after }, ctrl.signal)
            if (pollAbort === ctrl) pollAbort = null
            if (stopped || ctrl.signal.aborted) continue
            for (const event of reply?.events ?? []) {
              if (Number.isFinite(event.seq) && event.seq > after) after = event.seq
              if (Number.isFinite(event.t) && Number.isFinite(reply?.now) && reply.now - event.t > 3000) continue
              const botLook = lookOf(roster.getSnapshot().byId[event.botId])
              appComputer.computerCursor({ ...event, color: botLook.color, avatar: botLook.image })
            }
          } catch {
            if (pollAbort === ctrl) pollAbort = null
            if (!stopped && roster.getSnapshot().computer?.enabled === true) await pause(2000)
          }
        }
      }
      void runCursor()
      cleanups.push(() => { abortPoll(); offCursorRoster(); notifyEnabled(); cancelPause?.() })
    }
    if (typeof appComputer?.idleSeconds === 'function') {
      let idleTimer = 0
      const pushIdle = () => {
        if (stopped) return
        const current = roster.getSnapshot()
        if (current.computer?.enabled !== true) return
        if (!needsIdleSample(computer.getSnapshot(), current.computer)) return
        void Promise.resolve(appComputer.idleSeconds()).then((idle) => {
          if (!stopped && Number.isFinite(idle)) call('computer-user-active', { idleSeconds: idle }).catch(() => {})
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
    cleanups.push(roster.subscribe(() => { questionDrafts.reconcileRoster(roster.getSnapshot()) }))
    if (typeof window?.addEventListener === 'function') {
      const onStorage = (event) => {
        if (event.key === null || event.key === STORAGE.rescuedDrafts) questionDrafts.syncFromStorage()
      }
      window.addEventListener('storage', onStorage)
      cleanups.push(() => window.removeEventListener('storage', onStorage))
    }
    if (typeof document === 'undefined' || !document.hidden) startTimer()
    if (typeof document?.addEventListener === 'function') document.addEventListener('visibilitychange', onVisibility)
    const onPageHide = () => leaveVisits(Object.keys(ui.getSnapshot().visits ?? {}))
    window.addEventListener('pagehide', onPageHide)
    return () => {
      stopped = true
      clearTimeout(updateTimer)
      clearTimeout(lostTimer)
      lostTimer = undefined
      lostSince = 0
      wakeUpdate = () => {}
      scheduleUpdate = () => {}
      unsubscribeAppUpdates?.()
      restartFeed = () => {}
      unsubscribeOwnApp?.()
      stopAccountExternal()
      stopBotCompletions()
      avatarRefs.clear()
      avatarIncomplete = false
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
    useUserQuestions: use(userQuestions),
    useSessionQueues: use(sessionQueues),
    useMemoryNews: use(memoryNews),
    useLive: use(live),
    useCards: use(cards),
    useHeldCards: use(heldCards),
    useRescuedDrafts: use(questionDrafts.rescued),
    useTurnClock: use(turnClock),
    useUpdate: use(update),
    useConnection: use(connection),
    useRegistry: use(registry),
    useComputer: use(computer),
    useBrowserHolds: use(browserHolds),
    useBrowserPages: use(browserPages),
    useBrowserTabs: use(browserTabs),
    useBotCompletions: use(botCompletions),
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
  const snapshots = {
    roster: () => roster.getSnapshot(),
    sessions: () => sessions.getSnapshot(),
    ui: () => ui.getSnapshot(),
    shown: () => shown.getSnapshot(),
    surface: () => surface.getSnapshot(),
    status: () => status.getSnapshot(),
    connection: () => connection.getSnapshot(),
  }
  return { actions, hooks, snapshots, sessionHook, chat, start }
}
