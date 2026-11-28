// Desktop adapter for team-core: connects the shared state store and action
// orchestration (`ds-bot/src/client/team-core`) to the standalone window's
// live feed (`openFeed`), Electron bridge (`dsBotApp`), Classic Agent adapter
// (`classic-adapter.js`), and right-panel workspace tabs.
import { useRef, useSyncExternalStore } from 'react'
import { watchAgentTerminals } from '../../../ds-bot/src/client/agent-terminals.js'
import { call } from '../../../ds-bot/src/client/api.js'
import { noticeApprovals } from '../../../ds-bot/src/client/approval-notices.js'
import { watchBotCompletions } from '../../../ds-bot/src/client/bot-completions.js'
import { workPhrase } from '../../../ds-bot/src/client/cells.js'
import { frameLayout } from '../../../ds-bot/src/client/frame-layout.js'
import { requestPreparation } from '../../../ds-bot/src/client/speech.js'
import { writeMode } from '../../../ds-bot/src/client/surface.js'
import {
  assembleTeamActions,
  createBrowserController,
  createDraftFiles,
  createFeedController,
  createNavigationActions,
  createSessionStore,
  createTeamPull,
  createTeamStore,
  createUpdateController,
  EMPTY_PENDING,
  pruneRemovedChatDrafts,
  sectionFoldWrites,
  SETTINGS_PANEL_IDS,
  startComputerBridge,
} from '../../../ds-bot/src/client/team-core/index.js'
import { currentPart } from '../../../ds-bot/src/client/text.js'
import { registry } from '../../../ds-bot/src/client/themes.js'
import { openFeed } from './api.js'
import { createClassicAdapter } from './classic-adapter.js'
import { createDesktopAccountBridge, publishDesktopAccountState, subscribeDesktopAccountState } from './deepseek-account.js'
import { pruneFailedSends } from './failed-send-bar.js'
import { slots } from './slots.js'

export { publishDesktopAccountState, subscribeDesktopAccountState }

// Memory news and connector states change without a notice on the feed.
const CATCH_UP_MS = 15_000
const RECONNECT_NOTICE_MS = 2_000
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

const setChanged = (source, value) => { if (JSON.stringify(source.getSnapshot()) !== JSON.stringify(value)) source.set(value) }

export function createTeam() {
  const store = createTeamStore({ extraUi: { rightPanel: null }, initialViewport: 1280 })
  const {
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
    partFor,
  } = store

  let restartFeed = () => {}
  let terminalNonceSeq = 0
  const sessionHooks = new Map()
  const draftFilesCtrl = createDraftFiles()

  let classic = null
  const sessionStore = createSessionStore({
    store,
    workPhrase,
    onNoteLive: (sid, kind, value) => actions.noteLive(sid, kind, value),
    onShow: (id, snap) => classic?.noteShown(id, snap),
    onPruneExtra: (keep) => {
      for (const id of sessionHooks.keys()) if (!keep(id)) sessionHooks.delete(id)
      draftFilesCtrl.pruneBySessions(keep)
    },
  })
  const {
    sessions,
    status,
    sent,
    shown,
    userQuestions,
    sessionQueues,
    connection,
    chat,
    setStatus,
    show,
    mergeSessionQueues,
    setUserQuestions,
    followWork,
    pruneSessions,
  } = sessionStore

  // Bot browsers need a webview bridge: DSH Desktop's, or the desktop app's of the
  // same shape. Classic mode shares the same browser view plumbing under a dedicated owner key.
  const resolveBrowserOwner = (id) => {
    const snap = roster.getSnapshot()
    const bot = id ? snap.byId?.[id] : undefined
    if (bot) return { ownerId: bot.id, detailsId: id, isClassic: false, toggleId: bot.id }
    if (id === CLASSIC_BROWSER_OWNER || surface.getSnapshot().mode === 'agent') {
      return { ownerId: CLASSIC_BROWSER_OWNER, detailsId: shown.getSnapshot() || CLASSIC_BROWSER_OWNER, isClassic: true, toggleId: CLASSIC_BROWSER_OWNER }
    }
    return null
  }
  const browserCtrl = createBrowserController({
    call,
    store,
    resolveOwner: resolveBrowserOwner,
    extraRetainIds: () => [CLASSIC_BROWSER_OWNER],
    yieldBrowser: () => true,
    onClosePanel: () => actions.closePanel(),
    onTabsEmptied: (botId) => {
      const snap = roster.getSnapshot()
      ui.set((state) => {
        if (!state.details || state.view !== 'browser') return state
        const subjectBot = snap.byId?.[state.details]
        if (subjectBot && subjectBot.id !== botId) return state
        if (!subjectBot && botId !== CLASSIC_BROWSER_OWNER) return state
        const hasWorkspace = (state.rightPanel?.tabs?.length ?? 0) > 0
        if (hasWorkspace) return { ...state, view: 'workspace', renaming: false, tab: null }
        const hasSide = Boolean(subjectBot && state.side && (snap.sideChats?.[subjectBot.id] ?? []).some(entry => entry?.id === state.side))
        if (hasSide) return { ...state, view: 'side', renaming: false, tab: null }
        if (subjectBot || snap.roomsById?.[state.details]) return { ...state, view: 'details', renaming: false, tab: null }
        return { ...state, details: null, view: 'details', renaming: false, tab: null, side: null, task: null, panelYield: false, rightPanel: null }
      })
    },
    reconcileUi: (snapshot, on) => {
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
    },
  })
  const { browsers, browserHolds, browserPages, browserTabs } = browserCtrl

  const updateCtrl = createUpdateController({ call, update })

  const foldWrites = sectionFoldWrites()
  const { pull, reset: resetPull } = createTeamPull({
    call,
    store,
    foldWrites,
    onLiveValue: (value) => {
      if (value.userQuestions !== undefined) setUserQuestions(value.userQuestions)
      if (value.sessionQueues !== undefined) mergeSessionQueues(value.sessionQueues)
      if (value.browserHolds !== undefined) setChanged(browserHolds, value.browserHolds)
    },
    onChatsRemoved: (gone) => {
      pruneRemovedChatDrafts(gone, questionDrafts)
    },
    onHydrated: (indexed) => {
      classic.onHydrated(indexed)
      // Follow a Bot or group chat onto its new segment when context rolls over or moves to background.
      // On first load in Bot mode, land on the Main Bot in the same tick as `roster.set` so the
      // team window paints the chat immediately instead of sitting 400 ms on a blank main area.
      const open = shown.getSnapshot()
      if (open) {
        const target = indexed.byId[open] ?? indexed.roomsById[open]
        const nextPart = target ? currentPart(target) : open
        if (nextPart && nextPart !== open) show(nextPart)
      } else if (surface.getSnapshot().mode === 'agent') {
        const latest = classic.initialLandingSession(indexed)
        if (latest) show(latest)
      } else {
        const target = indexed.mainBotId ?? indexed.bots?.[0]?.id
        if (target) show(partFor(target))
      }
      pruneSessions(indexed)
    },
  })
  const after = promise => promise.then(async (value) => { await pull().catch(() => {}); return value })

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
  const nav = createNavigationActions({
    call,
    after,
    pull,
    store,
    onRetry: target => actions.openSession(target),
    onRecovered: target => actions.openSession(target),
    onMissingAfterRecover: () => ui.set(state => (state.pendingOpen === null ? state : { ...state, pendingOpen: null })),
    onLand: target => show(target),
    reportError: (error, where) => actions.reportError?.(error, where),
  })

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
  const clearClosedRightPanel = () => {
    ui.set(state => (state.details === null && (state.rightPanel !== null || state.panelYield) ? { ...state, rightPanel: null, panelYield: false } : state))
  }

  classic = createClassicAdapter({
    call,
    after,
    pull,
    store,
    sessionStore,
    nav,
    browsers,
    classicBrowserOwner: CLASSIC_BROWSER_OWNER,
    pruneStaleWorkspace,
    pruneFailedSends,
    getActions: () => actions,
  })

  const actions = assembleTeamActions({
    call,
    after,
    store,
    foldWrites,
    panelFolded,
    nav,
    updateCtrl,
    browserCtrl,
    host: {
      afterClosePanel: () => ui.set(state => (state.rightPanel !== null || state.panelYield ? { ...state, rightPanel: null, panelYield: false } : state)),
      afterCloseOverlay: clearClosedRightPanel,
      afterToggleDetails: clearClosedRightPanel,
      openChanges: changes => openWorkspaceTab('changes', prev => ({ ...prev, changes }), changes.sessionId),
      steerQueued: async (sessionId, { tryBotBatch, reportSteerError }) => {
        const rows = sessionQueues.getSnapshot()[sessionId] ?? []
        const ids = rows
          .filter(row => typeof row?.id === 'string' && row.id !== '' && row?.source?.kind === 'user')
          .map(row => row.id)
        if (ids.length === 0) return
        try {
          const outcome = await tryBotBatch(ids)
          if (outcome === 'done') return
          if (outcome === 'failed') { reportSteerError(); return }
          await actions.steerSessionQueue(sessionId, ids)
        } catch {
          reportSteerError()
        }
      },
      isAgentSession: id => classic.isAgentSession(id),
      openTeamSession: ({ id, target, fromInbox }) => {
        if (surface.getSnapshot().mode === 'agent') {
          writeMode('bot')
          surface.set({ mode: 'bot' })
        }
        classic.noteTeamSession(id)
        const switched = target !== shown.getSnapshot()
        show(target)
        ui.set((state) => {
          const dropOverlay = Boolean(state.newChat || state.exchange || state.menu || state.palette || state.groupSearch || state.shortcuts || state.inbox || state.inboxTarget || state.pendingOpen)
          const rp = switched ? pruneStaleWorkspace(state.rightPanel) : state.rightPanel
          const foldWorkspace = switched && state.view === 'workspace' && rp === null
          if (!dropOverlay && rp === state.rightPanel && !foldWorkspace) return state
          return {
            ...state,
            ...(dropOverlay ? { newChat: null, exchange: null, menu: null, palette: null, groupSearch: null, shortcuts: false, inbox: false, inboxTarget: fromInbox ? target : null, pendingOpen: null } : {}),
            ...(foldWorkspace ? { view: 'details' } : {}),
            rightPanel: rp,
          }
        })
      },
      openAgentSession: sessionId => classic.openAgentSession(sessionId),
      setSurface: mode => classic.setSurface(mode),
      agent: classic.agent,
      selectPanel: (id, a) => {
        if (typeof id !== 'string' || id === '') return
        if (id === 'files' || id === 'terminal' || id === 'preview' || id === 'changes') {
          openWorkspaceTab(id)
          return
        }
        a.openSettings(SETTINGS_PANEL_IDS.has(id) ? id : 'overview')
      },
      canOpenFiles: () => true,
      openFiles: () => openWorkspaceTab('files'),
      canOpenTerminal: () => !roster.getSnapshot().readOnly,
      newTerminal: () => openWorkspaceTab('terminal', prev => ({ ...prev, terminalNonce: ++terminalNonceSeq })),
      watchAgentTerminals: (sessionId, a) => watchAgentTerminals(slots, sessionId, error => a.reportError?.(error, 'right-sidebar')),
      canReferenceChat: () => true,
      referenceChat: (sessionId, insertion) => chat.emit('reference-chat', { sessionId, insertion }),
      speech: () => (roster.getSnapshot().speech === true ? speechClient : undefined),
      voiceSetup: providerId => (roster.getSnapshot().speech === true && providerId !== undefined
        ? { prepare: () => requestPreparation(speechClient, providerId) }
        : null),
      closingReply: (sessionId, turn) => sessionStore.closingReply(sessionId, turn),
      turnFacts: sessionId => sessionStore.turnFacts(sessionId),
      watchTurns: (sessionId, listener) => sessionStore.watchTurns(sessionId, listener),
      drafts: draftFilesCtrl,
      account: accountBridge,
    },
    extra: {
      ...classic.extraActions,
      refreshLocale: () => pull().catch(() => {}),
      openShortcuts: () => ui.set(state => ({ ...state, shortcuts: true, menu: null, palette: null, groupSearch: null })),
      closeShortcuts: () => ui.set(state => (state.shortcuts ? { ...state, shortcuts: false } : state)),
      hasRightSidebar: () => true,
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
      consumeTerminalNonce: (nonce) => {
        if (!nonce) return
        ui.set((state) => {
          if (!state.rightPanel || state.rightPanel.terminalNonce !== nonce) return state
          return { ...state, rightPanel: { ...state.rightPanel, terminalNonce: 0 } }
        })
      },
      setRightPanelTab: tabId => openWorkspaceTab(tabId),
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
            const hasSide = Boolean(bot && state.side && (snap.sideChats?.[bot.id] ?? []).some(entry => entry?.id === state.side))
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
      hasPluginMic: () => false,
      noteTurnFacts: (sessionId, facts) => sessionStore.noteTurnFacts(sessionId, facts),
      noteSent: (sessionId, meta) => sessionStore.noteSent(sessionId, meta),
      noteReplyArrival: (sessionId, delta) => sessionStore.noteReplyArrival(sessionId, delta),
      reconnectFeed: () => { restartFeed() },
    },
  })

  // Running and the tool at work come with the team's state; the plugin reads them from
  // DSH's Session status and its own tool cells.
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
    const feed = createFeedController({
      store,
      sessionStore,
      openFeed,
      read,
      onNoteLive: (sid, kind, value) => actions.noteLive(sid, kind, value),
      isCovered,
      reconnectNoticeMs: RECONNECT_NOTICE_MS,
    })
    restartFeed = () => feed.restart()
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
    read()
    const stopUpdates = updateCtrl.start()
    const stopAccountExternal = accountBridge.subscribeExternal()
    void accountBridge.refresh()
    const stopBotCompletions = watchBotCompletions({
      roster,
      sessions,
      statuses: status,
      unread: botCompletions,
      ui,
      onReconcile: sessionStore.onOutlineReconcile,
    })
    const stopFeed = feed.start()
    const stopApprovalNotices = noticeApprovals({
      work,
      roster,
      shownSession: () => shown.getSnapshot(),
      openSession: actions.openSession,
    })
    const stopBrowsers = browserCtrl.start()
    const cleanups = [
      startComputerBridge({
        call,
        store,
        onStop: (botId, all) => actions.computerStop(botId, all),
        onAllowForeground: botId => actions.computerAllowForeground(botId),
      }),
      roster.subscribe(() => { questionDrafts.reconcileRoster(roster.getSnapshot()) }),
      store.attachWindowListeners(globalThis.window),
    ]
    if (typeof document === 'undefined' || !document.hidden) startTimer()
    if (typeof document?.addEventListener === 'function') document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stopped = true
      stopUpdates()
      restartFeed = () => {}
      stopAccountExternal()
      stopBotCompletions()
      resetPull()
      stopFeed()
      stopApprovalNotices()
      stopBrowsers()
      for (const cleanup of cleanups) cleanup()
      stopTimer()
      if (typeof document?.removeEventListener === 'function') document.removeEventListener('visibilitychange', onVisibility)
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
    useFrame: use(frame),
    useSidebarPref: use(sidebarPref),
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
  return { actions, hooks, snapshots, sessionHook, chat, classic, start }
}
