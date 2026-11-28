// Desktop Classic Agent adapter: encapsulates classic session list metadata,
// Bot <-> Classic surface position memory, and Classic Agent CRUD / session-control
// calls behind a dedicated interface that W8 (#2515) can extend cleanly.
import { pruneDrafts } from '../../../ds-bot/src/client/draft-keep.js'
import { writeMode } from '../../../ds-bot/src/client/surface.js'

/**
 * Create the standalone desktop Classic Agent adapter.
 *
 * Interface contract for W8 (#2515):
 * - Query/state helpers: `isAgentSession(id)`, `latestAgentSession(agentId)`,
 *   `noteShown(id, rosterSnap)`, `noteTeamSession(id)`, `onHydrated(rosterSnap)`,
 *   `refreshClassicSessions()`
 * - Actions (`adapter.actions`):
 *   - Surface & opening: `setSurface`, `openAgentSession`, `addAgent`, `openAgent`,
 *     `newAgentSession`, `archiveAgentSession`, `renameAgentSession`, `removeAgent`,
 *     `stopAgent`, `createClassicSession`, `startPresetCreator`, `refreshClassicSessions`
 *   - Per-session controls: `sessionControls`, `selectSessionModel`, `setSessionPermission`,
 *     `sessionCommands`, `runSessionCommand`, `sessionSkills`, `sessionFiles`,
 *     `answerUserQuestion`, `dismissUserQuestion`, `updateSessionQueue`, `steerSessionQueue`
 */
export function createClassicAdapter({
  call,
  after,
  pull,
  store,
  sessionStore,
  nav,
  browsers,
  classicBrowserOwner,
  pruneStaleWorkspace,
  pruneFailedSends,
  getActions,
}) {
  const { roster, ui, surface, questionDrafts } = store
  const { sessions, shown, editRow, clearShown, show } = sessionStore

  // Remember positions in both modes so switching Bot <-> Classic preserves each side.
  let lastTeamSession = null
  let lastAgentSession = null
  const agentNewInFlight = new Map()
  let classicSeq = 0

  const isAgentSession = id => Boolean(id && roster.getSnapshot().agentOf?.[id] !== undefined)

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

  const fetchClassicSessions = async () => {
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

  const noteShown = (id, snap) => {
    if (snap.agentOf?.[id] !== undefined) lastAgentSession = id
    else if (snap.byId?.[id] !== undefined || snap.roomsById?.[id] !== undefined) lastTeamSession = id
  }

  const noteTeamSession = (id) => { lastTeamSession = id }

  const onHydrated = (indexed) => {
    if ((indexed.agents ?? []).some(agent => (agent.sessions?.length ?? 0) > 0)) {
      void fetchClassicSessions()
    }
  }

  const initialLandingSession = (indexed) => {
    const firstAgent = (indexed.agents ?? [])[0]
    return firstAgent ? (latestAgentSession(firstAgent.id) ?? firstAgent.sessions?.[0]) : undefined
  }

  const openAgentSession = (sessionId) => {
    if (!sessionId) return
    nav.bumpNavSeq()
    const switched = sessionId !== shown.getSnapshot()
    const fromInbox = ui.getSnapshot().inbox === true
    lastAgentSession = sessionId
    const hasClassicBrowser = Boolean(
      roster.getSnapshot().browser === true
      && browsers
      && (browsers.tabs.getSnapshot()[classicBrowserOwner]?.ids?.length ?? 0) > 0,
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
  }

  const setSurface = async (mode) => {
    const actions = getActions()
    const nextMode = mode === 'agent' ? 'agent' : 'bot'
    const prevShown = shown.getSnapshot()
    if (prevShown) {
      if (isAgentSession(prevShown)) lastAgentSession = prevShown
      else lastTeamSession = prevShown
    }
    if ((nextMode === 'agent' && prevShown && !isAgentSession(prevShown))
      || (nextMode === 'bot' && prevShown && isAgentSession(prevShown))) {
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
  }

  const addAgent = async (options = {}) => {
    const actions = getActions()
    const agentPreset = typeof options?.agentPreset === 'string' && options.agentPreset.trim() !== '' ? options.agentPreset.trim() : undefined
    const agent = await after(call('add-agent', agentPreset ? { agentPreset } : {}))
    await fetchClassicSessions()
    if (agent?.sessions?.[0] !== undefined) actions.openAgentSession(agent.sessions[0])
    return agent
  }

  const openAgent = (agentId) => {
    const actions = getActions()
    const agent = roster.getSnapshot().agentsById?.[agentId]
    if (agent === undefined) return undefined
    const latest = latestAgentSession(agentId)
    if (latest === undefined) return actions.newAgentSession(agentId)
    actions.openAgentSession(latest)
    return latest
  }

  const newAgentSession = async (agentId, options = {}) => {
    const actions = getActions()
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
      void fetchClassicSessions()
      return sessionId
    })().finally(() => { agentNewInFlight.delete(flightKey) })
    agentNewInFlight.set(flightKey, workPromise)
    return workPromise
  }

  const archiveAgentSession = async (agentId, sessionId) => {
    const actions = getActions()
    await after(call('agent-archive', { agentId, sessionId }))
    questionDrafts?.pruneChats([sessionId])
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
    void fetchClassicSessions()
  }

  const renameAgentSession = async (agentId, sessionId, title) => {
    await after(call('agent-rename', { agentId, sessionId, title }))
    const clean = String(title ?? '').trim()
    editRow(sessionId, row => ({ ...row, title: clean, displayTitle: clean, blank: false }))
    void fetchClassicSessions()
  }

  const removeAgent = async (agentId) => {
    const actions = getActions()
    const owned = roster.getSnapshot().agentsById?.[agentId]?.sessions ?? []
    const result = await after(call('remove-agent', { agentId }))
    if (owned.length > 0) {
      questionDrafts?.pruneChats(owned)
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
  }

  const stopAgent = (agentId, sessionId) => after(call('stop-agent', sessionId ? { agentId, sessionId } : { agentId }))

  const createClassicSession = (options = {}) => {
    const actions = getActions()
    const snap = roster.getSnapshot()
    if (snap.readOnly) return undefined
    const agent = (snap.agents ?? [])[0]
    return agent ? actions.newAgentSession(agent.id, options) : actions.addAgent(options)
  }

  const startPresetCreator = async () => {
    const actions = getActions()
    const snap = roster.getSnapshot()
    if (snap.readOnly) return undefined
    const prevShown = shown.getSnapshot()
    if (prevShown && !isAgentSession(prevShown)) lastTeamSession = prevShown
    if (surface.getSnapshot().mode !== 'agent') {
      clearShown()
      surface.set({ mode: 'agent' })
      writeMode('agent')
    }
    return actions.createClassicSession({ agentPreset: 'cordis' })
  }

  const refreshClassicSessions = async () => {
    await pull().catch(() => {})
    await fetchClassicSessions()
  }

  const sessionControlActions = {
    stopAgent,
    createClassicSession,
    startPresetCreator,
    refreshClassicSessions,
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
  }

  const agent = {
    addAgent,
    openAgent,
    newAgentSession,
    archiveAgentSession,
    renameAgentSession,
    removeAgent,
  }

  return {
    isAgentSession,
    latestAgentSession,
    noteShown,
    noteTeamSession,
    onHydrated,
    initialLandingSession,
    refreshClassicSessions,
    setSurface,
    openAgentSession,
    agent,
    extraActions: sessionControlActions,
    actions: {
      isAgentSession,
      setSurface,
      openAgentSession,
      ...agent,
      ...sessionControlActions,
    },
  }
}
