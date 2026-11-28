// Shared team state store: observable sources for roster, ui, layout, work,
// activity, computer, memoryNews, live transcript notes, card counts, update
// state, and cross-window unread/reaction/visit storage sync.
import { readSidebar, SIDEBAR_MAX, SIDEBAR_MIN, toggledPref, writeSidebar } from '../frame-layout.js'
import { createQuestionDrafts } from '../question-draft.js'
import { noteLeft, setUnread, sharedMap, toggleReaction } from '../shared-map.js'
import { migrateStorage, STORAGE } from '../storage.js'
import { readMode } from '../surface.js'
import { createSource, EMPTY_ROSTER, partForRoster, seenKeyOf } from './roster.js'

const NO_WORK = { bots: {}, approvals: [] }

const CACHED_PREF_KEYS = [
  'theme', 'accent', 'motion', 'layout', 'effects',
  'width', 'flatWidth', 'thinking', 'defaultBotModel', 'enterToSend',
]

export function readSavedPrefs(storage = globalThis.localStorage) {
  try {
    const parsed = JSON.parse(storage?.getItem?.(STORAGE.prefs) ?? '{}')
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function persistPrefs(prefs, storage = globalThis.localStorage) {
  if (!prefs || typeof prefs !== 'object') return
  const out = {}
  for (const key of CACHED_PREF_KEYS) out[key] = prefs[key]
  try {
    storage?.setItem?.(STORAGE.prefs, JSON.stringify(out))
  } catch { /* storage unavailable */ }
}

export function createTeamStore({
  storage = globalThis.localStorage,
  extraUi = null,
  surfaceExtra = null,
  initialViewport = typeof window === 'undefined' ? 0 : window.innerWidth,
} = {}) {
  migrateStorage()
  const savedPrefs = readSavedPrefs(storage)
  const unreadStore = sharedMap(STORAGE.unread)
  const reactionStore = sharedMap(STORAGE.reactions)
  // When each conversation was last left; a visit compares new turns against it.
  const seenStore = sharedMap(STORAGE.seen)
  let seenAt = seenStore.read()

  const roster = createSource({ ...EMPTY_ROSTER, prefs: savedPrefs })
  const botCompletions = createSource({})
  const ui = createSource({
    details: null,
    view: 'details',
    renaming: false,
    tab: null,
    side: null,
    task: null,
    taskDeck: null,
    newChat: null,
    exchange: null,
    menu: null,
    voice: null,
    palette: null,
    quote: null,
    paste: {},
    pendingOpen: null,
    settings: null,
    releaseNotes: null,
    memory: null,
    toast: null,
    signIn: null,
    renameAgent: null,
    unread: unreadStore.read(),
    reactions: reactionStore.read(),
    visits: {},
    panelYield: false,
    leftDrawer: false,
    bootFailed: false,
    goalCompose: null,
    goalOpen: null,
    approvalOpen: null,
    inbox: false,
    ...(extraUi ?? {}),
  })

  let sidebarSaved = readSidebar(storage)
  const sidebarPref = createSource(sidebarSaved.pref)
  const layout = createSource({ ...sidebarSaved, wide: sidebarSaved.pref === 'open' })
  const frame = createSource({
    viewport: initialViewport,
    sidebarWidth: sidebarSaved.width,
    collapsedWidth: 0,
    collapsed: false,
  })
  const surface = createSource({ mode: readMode(), ...(surfaceExtra ?? {}) })

  const activity = createSource({})
  const work = createSource(NO_WORK)
  const computer = createSource({})
  const live = createSource({})
  const cards = createSource({})
  const heldCards = createSource({})
  const turnClock = createSource({})
  const update = createSource({ available: false, phase: 'idle' })
  const questionDrafts = createQuestionDrafts({ storage })

  // Per Bot, its latest memory change, and `seen`: when this window first saw it, or 0
  // for a change made before the window opened, which is no news.
  const memoryNews = createSource({})
  let memoryNewsKey
  const noteMemoryNews = (next) => {
    const key = JSON.stringify(next)
    if (key === memoryNewsKey) return
    const opening = memoryNewsKey === undefined
    memoryNewsKey = key
    memoryNews.set(state => Object.fromEntries(Object.entries(next).map(([id, entry]) => [
      id,
      state[id]?.at === entry.at ? state[id] : { ...entry, seen: opening ? 0 : Date.now() },
    ])))
  }

  const partFor = id => partForRoster(roster.getSnapshot(), id)
  const seenKey = id => seenKeyOf(roster.getSnapshot(), id)
  const hasSeenRecords = () => Object.keys(seenAt).length > 0

  const leaveVisits = (ids) => {
    seenAt = seenStore.update(seen => noteLeft(seen, ids.map(seenKey), Date.now()), seenAt)
  }

  const writeUnread = (id, value) => {
    const unread = unreadStore.update(marks => setUnread(marks, id, value), ui.getSnapshot().unread)
    ui.set(state => (JSON.stringify(state.unread) === JSON.stringify(unread) ? state : { ...state, unread }))
  }

  const beginVisit = (id) => {
    // A conversation a Bot started, never opened here, is unread from its start.
    const snap = roster.getSnapshot()
    const made = snap.byId[id] ?? snap.roomsById[id]
    const seen = seenAt[seenKey(id)] ?? (made?.createdBy && Number.isFinite(made.createdAt) ? made.createdAt : null)
    ui.set(state => ({ ...state, visits: { ...state.visits, [id]: { seen, entered: Date.now() } } }))
  }

  const endVisit = (id) => {
    leaveVisits([id])
    ui.set((state) => {
      if (!(id in (state.visits ?? {}))) return state
      const visits = { ...state.visits }
      delete visits[id]
      return { ...state, visits }
    })
  }

  const toggleReactionEntry = (key, index, emoji) => {
    const reactions = reactionStore.update(saved => toggleReaction(saved, key, index, emoji), ui.getSnapshot().reactions)
    ui.set(state => ({ ...state, reactions }))
  }

  const setSidebarPref = (pref) => {
    const next = pref === 'rail' || pref === 'hidden' ? pref : 'open'
    const nextShown = next === 'hidden' ? sidebarSaved.shown : next
    if (sidebarSaved.pref === next && sidebarSaved.shown === nextShown) return
    sidebarSaved = { ...sidebarSaved, pref: next, shown: nextShown }
    writeSidebar(sidebarSaved, storage)
    sidebarPref.set(next)
    layout.set({ ...sidebarSaved, wide: next === 'open' })
  }

  const setSidebarWidth = (width) => {
    if (!Number.isFinite(width)) return
    const clamped = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(width)))
    if (sidebarSaved.width === clamped) return
    sidebarSaved = { ...sidebarSaved, width: clamped }
    writeSidebar(sidebarSaved, storage)
    layout.set(state => (state.width === clamped ? state : { ...sidebarSaved, wide: state.pref === 'open' }))
    frame.set(state => (state.sidebarWidth === clamped ? state : { ...state, sidebarWidth: clamped }))
  }

  const toggleLeftHidden = ({ clearPanelYield = false } = {}) => {
    ui.set((state) => {
      const dropDrawer = Boolean(state.leftDrawer)
      const dropYield = clearPanelYield && Boolean(state.panelYield)
      if (!dropDrawer && !dropYield) return state
      return { ...state, leftDrawer: false, ...(dropYield ? { panelYield: false } : {}) }
    })
    setSidebarPref(toggledPref(sidebarPref.getSnapshot(), sidebarSaved.shown))
  }

  const setLeftDrawer = (on) => {
    const next = Boolean(on)
    ui.set(state => (state.leftDrawer === next ? state : { ...state, leftDrawer: next }))
  }

  const setPanelYield = (on) => {
    const next = Boolean(on)
    ui.set(state => (state.panelYield === next ? state : { ...state, panelYield: next }))
  }

  const syncStorageEvent = (event) => {
    if (event.storageArea !== undefined && event.storageArea !== storage) return
    if (event.key === null || event.key === unreadStore.key) ui.set(state => ({ ...state, unread: unreadStore.read(state.unread) }))
    if (event.key === null || event.key === reactionStore.key) ui.set(state => ({ ...state, reactions: reactionStore.read(state.reactions) }))
    if (event.key === null || event.key === seenStore.key) seenAt = seenStore.read(seenAt)
    if (event.key === null || event.key === STORAGE.rescuedDrafts) questionDrafts.syncFromStorage()
  }

  const attachWindowListeners = (win = globalThis.window) => {
    if (typeof win?.addEventListener !== 'function') return () => {}
    const onPageHide = () => leaveVisits(Object.keys(ui.getSnapshot().visits ?? {}))
    win.addEventListener('pagehide', onPageHide)
    win.addEventListener('storage', syncStorageEvent)
    return () => {
      win.removeEventListener('pagehide', onPageHide)
      win.removeEventListener('storage', syncStorageEvent)
    }
  }

  return {
    savedPrefs,
    roster,
    ui,
    activity,
    work,
    computer,
    memoryNews,
    live,
    cards,
    heldCards,
    turnClock,
    botCompletions,
    update,
    surface,
    sidebarPref,
    layout,
    frame,
    questionDrafts,
    unreadStore,
    reactionStore,
    seenStore,
    partFor,
    seenKey,
    hasSeenRecords,
    noteMemoryNews,
    leaveVisits,
    writeUnread,
    beginVisit,
    endVisit,
    toggleReaction: toggleReactionEntry,
    setSidebarPref,
    setSidebarWidth,
    toggleLeftHidden,
    setLeftDrawer,
    setPanelYield,
    syncStorageEvent,
    attachWindowListeners,
  }
}
