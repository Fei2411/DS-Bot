// Shared team action orchestration, update polling, Bot browser bridge actions,
// navigation helpers, and computer-use desktop bridge shared by both hosts.
import { createBotBrowsers, serveBrowserReads } from '../bot-browsers.js'
import { noteClientError } from '../diagnostics.js'
import { chatOfSession } from '../draft-keep.js'
import { sameVersion } from '../dsh-offer.js'
import { t } from '../i18n.js'
import { lookOf } from '../mark.js'
import { needsIdleSample } from '../polling.js'
import { countCards, createSource, heldCardKey } from '../sources.js'
import { currentPart } from '../text.js'

export function sectionFoldWrites() {
  const saved = new Map()
  return {
    note(id, collapsed, revision) { saved.set(id, { revision, collapsed }) },
    reconcile(sections, revision) {
      if (!sections || saved.size === 0) return sections
      for (const [id, fold] of saved) if (fold.revision <= revision) saved.delete(id)
      return saved.size === 0 ? sections : sections.map(section => {
        const fold = saved.get(section.id)
        return fold ? { ...section, collapsed: fold.collapsed } : section
      })
    },
  }
}

// The actions every window that draws the Bot views shares: dialogs and panels (the `ui`
// source), requests to the host, and the notes the transcript keeps. The shell around the
// views adds navigation and its own panels. `after` reads the team again once a request
// is done; `partFor` maps a Bot id, or any part of its chat, to its current part.
export function teamActions({ call, after, partFor, roster, ui, live, cards, heldCards, turnClock, panelFolded, questionDrafts, foldWrites }) {
  // A memory is a Bot's or a group chat's; both are opened by id.
  const memoryOf = id => (roster.getSnapshot().roomsById[id] ? { roomId: id } : { botId: id })
  const subjectOf = (snap, id) => snap.byId?.[id]?.id ?? snap.roomsById?.[id]?.id ?? id
  // Cards of long pastes, numbered as they come; each waits for the shell's attachment.
  let pastes = 0
  const pasteState = (state, sessionId, blocks) => ({ ...state, paste: { ...state.paste, [sessionId]: blocks } })
  // An action that shows the panel lands the yield with it: when a folded
  // panel's explicit opener fires, the column gives way in the same set.
  // `view` is the next view, since its minimum decides what fits; a yield already
  // given stays.
  const yieldTo = (state, view) => state.panelYield === true || panelFolded?.(view) === true
  // The panel on a side chat's view, on the chat the strip tab or menu named.
  const openSideChat = (sessionId, chatId) => {
    ui.set(state => ({ ...state, details: sessionId, view: 'side', side: chatId ?? null, renaming: false, tab: null, panelYield: yieldTo(state, 'side') }))
  }
  const clearShortcutsPatch = state => (state.shortcuts ? { shortcuts: false } : {})
  // `id` opens one Bot (page 'bots') or one group chat (page 'groups').
  const openSettings = (page = 'general', id = null) => { ui.set(state => ({ ...state, ...clearShortcutsPatch(state), settings: { page, id }, menu: null, palette: null, newChat: null })) }
  const MAX_TURN_CLOCK_SESSIONS = 40
  const turnClockOrder = new Set()
  const setTurnClock = (state, sessionId, turns) => {
    turnClockOrder.delete(sessionId)
    turnClockOrder.add(sessionId)
    const next = { ...state, [sessionId]: turns }
    while (turnClockOrder.size > MAX_TURN_CLOCK_SESSIONS) {
      const oldest = turnClockOrder.values().next().value
      turnClockOrder.delete(oldest)
      delete next[oldest]
    }
    return next
  }
  const sectionSaves = new Map()
  const saveSection = async (payload) => {
    const { id, collapsed } = payload
    if (typeof id !== 'string' || !id || typeof collapsed !== 'boolean' || Object.keys(payload).some(key => key !== 'id' && key !== 'collapsed')) {
      return after(call('section-save', payload))
    }
    const previous = sectionSaves.get(id)
    const save = async () => {
      const reply = await call('section-save', { ...payload, withRevision: true })
      const { section: saved, revision } = reply
      if (!Number.isSafeInteger(revision)) return after(Promise.resolve(reply))
      if (!saved) return saved
      roster.set(state => {
        // The full roster revision describes the last state read, not this one field.
        if (state.revision >= revision) return state
        foldWrites?.note(id, saved.collapsed, revision)
        const section = state.sections?.find(section => section.id === id)
        if (!section || Boolean(section.collapsed) === Boolean(saved.collapsed)) return state
        return { ...state, sections: state.sections.map(entry => (entry === section ? { ...entry, collapsed: saved.collapsed } : entry)) }
      })
      return saved
    }
    const pending = previous ? previous.then(save, save) : Promise.resolve().then(save)
    sectionSaves.set(id, pending)
    ui.set(state => ({ ...state, sectionFolds: { ...state.sectionFolds, [id]: collapsed } }))
    try {
      return await pending
    } finally {
      if (sectionSaves.get(id) === pending) {
        sectionSaves.delete(id)
        ui.set(state => {
          const sectionFolds = { ...state.sectionFolds }
          delete sectionFolds[id]
          return { ...state, sectionFolds }
        })
      }
    }
  }
  return {
    // The pane starts at the rail's edge, so a floating drawer would stick out from under it.
    openNewChat: (mode, sectionId = null) => { ui.set(state => ({ ...state, ...clearShortcutsPatch(state), newChat: mode, newChatSection: sectionId ?? null, inbox: false, inboxTarget: null, menu: null, palette: null, leftDrawer: false })) },
    // The inbox page sits over the conversation column like New chat (inbox.js).
    openInbox: () => { ui.set(state => ({ ...state, ...clearShortcutsPatch(state), inbox: true, inboxTarget: null, newChat: null, newChatSection: null, exchange: null, menu: null, palette: null, groupSearch: null, leftDrawer: false })) },
    closeInbox: () => { ui.set(state => (state.inbox ? { ...state, inbox: false, inboxTarget: null } : state)) },
    openPalette: (query = '') => { ui.set(state => ({ ...state, ...clearShortcutsPatch(state), palette: { query, token: Date.now() }, newChat: null, menu: null })) },
    // The token keeps a late exit timer from closing a palette opened again since.
    closePalette: (token) => { ui.set(state => (state.palette && (token === undefined || state.palette.token === token) ? { ...state, palette: null } : state)) },
    // Searching one group's own history, from its header.
    openGroupSearch: (roomId) => { if (roomId) ui.set(state => ({ ...state, ...clearShortcutsPatch(state), groupSearch: { roomId, token: Date.now() }, palette: null, newChat: null, menu: null })) },
    closeGroupSearch: (token) => { ui.set(state => (state.groupSearch && (token === undefined || state.groupSearch.token === token) ? { ...state, groupSearch: null } : state)) },
    openExchange: (a, b) => { if (a && b) ui.set(state => ({ ...state, exchange: [a, b] })) },
    openVoice: (id) => { if (id) ui.set(state => ({ ...state, voice: id, menu: null })) },
    closeVoice: () => { ui.set(state => (state.voice ? { ...state, voice: null } : state)) },
    toggleDetails: (id, force) => {
      ui.set((state) => {
        const snap = roster.getSnapshot()
        const sameSubject = state.details !== null && subjectOf(snap, state.details) === subjectOf(snap, id)
        const details = force || !sameSubject || state.view !== 'details' ? id : null
        // A folded panel is open but not shown: its opener then means "show it"
        // (the column yields it room), not "close it".
        if (details === null && panelFolded?.('details') === true) return { ...state, renaming: false, tab: null, details: id, view: 'details', panelYield: true }
        return { ...state, renaming: false, tab: null, details, view: 'details', ...(details !== null ? { panelYield: yieldTo(state, 'details') } : {}), ...(details === null && state.rightPanel !== undefined ? { rightPanel: null } : {}) }
      })
    },
    // The open panel follows the main view; a subject with no browser (a group
    // chat, an outside Session) settles on the details view. So does one that
    // does not own the open side chat. Moving between parts of the same Bot or
    // group keeps the panel's current view, settings/rename state, and tab intact.
    // Workspace tabs persist across sessions; a non-team session (e.g. Classic Agent)
    // keeps workspace when tabs exist and closes the panel otherwise.
    followPanel: (id) => {
      ui.set((state) => {
        if (!state.details || state.details === id) return state
        const snap = roster.getSnapshot()
        const hasSubject = snap.byId[id] !== undefined || snap.roomsById?.[id] !== undefined
        const hasWorkspace = (state.rightPanel?.tabs?.length ?? 0) > 0
        if (!hasSubject) {
          if (hasWorkspace) return { ...state, details: id, view: 'workspace', task: null, renaming: false, tab: null, side: null }
          if (state.rightPanel !== undefined) return { ...state, details: null, view: 'details', task: null, renaming: false, tab: null, side: null }
        }
        if (subjectOf(snap, state.details) === subjectOf(snap, id)) return { ...state, details: id }
        const view = state.view === 'workspace'
          ? (state.rightPanel !== undefined && !hasWorkspace ? 'details' : 'workspace')
          : state.view === 'browser' && snap.byId[id] === undefined ? 'details'
            : state.view === 'side' && !(snap.sideChats?.[snap.byId[id]?.id] ?? []).some(chat => chat?.id === state.side) ? 'details'
              : state.view === 'task' ? 'details'
                : state.view
        return { ...state, details: id, view, task: null, renaming: false, tab: null }
      })
    },
    showDetails: (id, tab = null) => { ui.set(state => ({ ...state, inbox: false, details: id, view: 'details', renaming: false, tab, panelYield: yieldTo(state, 'details') })) },
    // Opening the conversation would move focus to its composer and blur the name field.
    renameBot: (id) => { ui.set(state => ({ ...state, details: id, view: 'details', renaming: true, tab: null, panelYield: yieldTo(state, 'details') })) },
    openSettings,
    // DS Bot's own Models page: the providers DSH serves, their keys and models.
    openModels: () => openSettings('models'),
    closeSettings: () => { ui.set(state => (state.settings ? { ...state, settings: null } : state)) },
    openReleaseNotes: (options = {}) => { ui.set(state => ({ ...state, releaseNotes: { mode: 'manual', current: options?.current ?? null, notesUrl: options?.notesUrl ?? null }, menu: null, palette: null })) },
    closeReleaseNotes: () => { ui.set(state => (state.releaseNotes ? { ...state, releaseNotes: null } : state)) },
    claimReleaseNotes: version => after(call('release-notes-claim', { version })),
    openMemory: (id) => { ui.set(state => ({ ...state, memory: id, menu: null, palette: null })) },
    closeMemory: () => { ui.set(state => (state.memory ? { ...state, memory: null } : state)) },
    openConnectors: () => { ui.set(state => ({ ...state, ...clearShortcutsPatch(state), settings: { page: 'connectors', id: null }, menu: null, palette: null, newChat: null })) },
    hasPlugins: () => true,
    openPlugins: (focus = null) => openSettings('plugins', focus),
    signIn: () => ui.set(state => ({ ...state, signIn: (state.signIn ?? 0) + 1 })),
    closeSignIn: () => ui.set(state => ({ ...state, signIn: null })),
    learningAnswer: (id, approve) => after(call('learning-answer', { id, approve })),
    beginAgentRename: sessionId => ui.set(state => ({ ...state, renameAgent: sessionId })),
    endAgentRename: () => ui.set(state => (state.renameAgent ? { ...state, renameAgent: null } : state)),
    setPanelView: (view) => {
      if (view !== 'details' && view !== 'browser' && view !== 'side' && view !== 'task' && view !== 'workspace') return
      ui.set(state => (state.details && state.view !== view ? { ...state, view, ...(view === 'details' ? { tab: null } : {}), panelYield: yieldTo(state, view) } : state))
    },
    openTaskDeck: (targetId, taskId = null) => {
      if (!targetId) return
      ui.set(state => ({ ...state, taskDeck: { targetId, taskId, token: Date.now() }, approvalOpen: null, goalOpen: null, goalCompose: null, menu: null, palette: null }))
    },
    toggleTaskDeck: (targetId) => {
      if (!targetId) return
      ui.set(state => (state.taskDeck?.targetId === targetId
        ? { ...state, taskDeck: null }
        : { ...state, taskDeck: { targetId, taskId: null, token: Date.now() }, approvalOpen: null, goalOpen: null, goalCompose: null, menu: null, palette: null }))
    },
    closeTaskDeck: () => { ui.set(state => (state.taskDeck ? { ...state, taskDeck: null } : state)) },
    openTask: (sessionId, botId, taskId) => {
      if (!sessionId || !botId || !taskId) return
      ui.set(state => ({ ...state, details: sessionId, view: 'task', task: { botId, taskId }, renaming: false, tab: null, panelYield: yieldTo(state, 'details') }))
    },
    closeTask: () => {
      ui.set(state => (state.details && state.view === 'task' ? { ...state, view: 'details', task: null, tab: 'tasks' } : { ...state, task: null }))
    },
    stopTask: (botId, taskId) => after(call('bot-stop-task', { botId, taskId })),
    sendTask: (botId, taskId, text) => after(call('bot-task-send', { botId, taskId, text })),
    readTask: (botId, taskId, cursor, steps = false) => call('bot-task-read', { botId, taskId, ...(cursor ? { cursor } : {}), ...(steps ? { steps: true } : {}) }),
    moveToBackground: (botId, sessionId, expectedTurn) => after(call('bot-move-to-background', {
      botId,
      ...(sessionId ? { sessionId } : {}),
      ...(typeof expectedTurn === 'number' ? { expectedTurn } : {}),
      operationId: typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `bg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    })),
    steerQueueBatch: (sessionId, ids) => call('bot-steer-queue', { sessionId, ids }),
    // A side chat on the panel's own view, opened from the strip, the `···`
    // menus or `/side`. Closing the panel keeps the chats; only a tab's × deletes.
    openSideChat,
    // The roster is pulled before the panel opens on a new chat: a view on a chat
    // the roster does not hold yet folds back into details.
    newSideChat: async (sessionId) => {
      const value = await after(call('side-new', { sessionId }))
      openSideChat(sessionId, value?.chatId)
      return value
    },
    sideCall: (name, body) => after(call(name, body)),
    askSide: (sessionId, chatId, text) => after(call('side-ask', { sessionId, chatId, text })),
    cancelSide: (chatId, entryId) => after(call('side-cancel', { chatId, entryId })),
    closeSideChat: (chatId) => {
      ui.set(state => (state.details && state.view === 'side' && state.side === chatId ? { ...state, view: 'details', side: null } : state))
      return after(call('side-close', { chatId }))
    },
    closePanel: () => {
      ui.set(state => (state.details || state.rightPanel
        ? { ...state, details: null, ...(state.rightPanel !== undefined ? { rightPanel: null } : {}), view: 'details', renaming: false, tab: null, side: null, task: null }
        : state))
    },
    quote: (sessionId, text) => ui.set(state => ({ ...state, quote: { sessionId, text, token: Date.now() } })),
    // A long paste becomes a card; its text stays here until it goes back into the box.
    addPaste: (sessionId, text, name) => {
      pastes += 1
      const block = { id: `paste-${pastes}`, text, name, attachmentId: null }
      ui.set(state => pasteState(state, sessionId, [...(state.paste?.[sessionId] ?? []), block]))
      return block.id
    },
    // The shell attachment whose label is that waiting card's own file name.
    linkPastes: (sessionId, links) => ui.set((state) => {
      const blocks = state.paste?.[sessionId] ?? []
      const byBlock = new Map()
      for (const link of links) byBlock.set(link.blockId, link.attachmentId)
      const linked = blocks.map((block) => {
        if (block.attachmentId !== null) return block
        const id = byBlock.get(block.id)
        return id === undefined ? block : { ...block, attachmentId: id }
      })
      return linked.every((block, index) => block === blocks[index]) ? state : pasteState(state, sessionId, linked)
    }),
    // Files put back into a draft get new attachment ids: the cards of `from` wait for
    // their files again in `to`, and bind by name as on a paste.
    reopenPastes: (from, to) => ui.set((state) => {
      const blocks = state.paste?.[from] ?? []
      if (blocks.length === 0) return state
      const waiting = blocks.map(block => ({ ...block, attachmentId: null }))
      if (from === to) return pasteState(state, to, waiting)
      const { [from]: _left, ...rest } = state.paste
      return { ...state, paste: { ...rest, [to]: [...(rest[to] ?? []), ...waiting] } }
    }),
    unlinkPastes: (sessionId, blockIds) => ui.set((state) => {
      const blocks = state.paste?.[sessionId] ?? []
      const waiting = blocks.map(block => (blockIds.includes(block.id) && block.attachmentId !== null ? { ...block, attachmentId: null } : block))
      return waiting.every((block, index) => block === blocks[index]) ? state : pasteState(state, sessionId, waiting)
    }),
    removePaste: (sessionId, blockIds) => ui.set((state) => {
      const blocks = state.paste?.[sessionId] ?? []
      const kept = blocks.filter(block => !blockIds.includes(block.id))
      return kept.length === blocks.length ? state : pasteState(state, sessionId, kept)
    }),
    clearQuote: token => ui.set(state => (state.quote?.token === token ? { ...state, quote: null } : state)),
    setFlags: (id, flags) => after(call('set-flags', { id, ...flags })),
    saveSection,
    reorderSections: ids => after(call('section-order', { ids })),
    deleteSection: id => after(call('section-delete', { id })),
    beginSectionRename: id => ui.set(state => ({ ...state, renameSection: id })),
    endSectionRename: () => ui.set(state => (state.renameSection ? { ...state, renameSection: null } : state)),
    deleteRoom: id => after(call('delete-room', { id })),
    openMenu: (menu) => { ui.set(state => ({ ...state, menu, palette: null })) },
    closeMenu: () => { ui.set(state => (state.menu ? { ...state, menu: null } : state)) },
    closeNewChat: () => { ui.set(state => (state.newChat || state.newChatSection ? { ...state, newChat: null, newChatSection: null } : state)) },
    closeExchange: () => { ui.set(state => (state.exchange ? { ...state, exchange: null } : state)) },
    closeOverlay: () => {
      ui.set((state) => {
        const keepPanel = Boolean(state.newChat || state.exchange || state.inbox)
        return {
          ...state,
          newChat: null,
          newChatSection: null,
          exchange: null,
          inbox: false,
          details: keepPanel ? state.details : null,
          ...(keepPanel || state.rightPanel === undefined ? {} : { rightPanel: null }),
        }
      })
    },
    createBot: payload => after(call('create-bot', payload)),
    // The avatar library: photos the user imported once, kept by the host.
    avatarLibrary: (options = {}) => call('avatar-library', options),
    importAvatars: items => call('avatar-import', { items }),
    deleteAvatar: id => call('avatar-delete', { id }),
    createRoom: (members, options = {}) => after(call('create-room', { members, ...options })),
    updateBot: (id, patch) => after(call('update-bot', { id, ...patch })),
    // Give up one wait the Bot has on a hand-off that will not come back.
    abandonWork: id => after(call('abandon-work', { id })),
    resumeWork: id => after(call('resume-work', { id })),
    cancelWork: (id, reason) => after(call('cancel-work', { id, ...(reason ? { reason } : {}) })),
    resumeRoomPause: roomId => after(call('resume-room-pause', { roomId })),
    refreshModels: () => after(call('models')).catch(() => {}),
    // The Agent presets of the profile: the directory the Agent preset picker shows.
    presets: () => call('presets'),
    // One local agent's models: the first look starts its CLI, later ones read what it said.
    agentModels: route => after(call('local-agent-models', { route })).catch(() => {}),
    efforts: ref => call('efforts', { ref }),
    // Model providers and their API keys; DSH keeps them, and a key only travels to the host.
    providers: () => call('providers'),
    chatgpt: () => call('chatgpt'),
    chatgptSignIn: body => call('chatgpt-sign-in', body),
    chatgptCancel: () => call('chatgpt-cancel'),
    chatgptSignOut: () => call('chatgpt-sign-out'),
    chatgptModels: () => call('chatgpt-models'),
    setProviderKey: (provider, value) => after(call('provider-key', { provider, value })),
    addProvider: body => after(call('provider-add', body)),
    providerModels: body => call('provider-models', body),
    saveProviderModels: body => call('provider-models-save', body),
    removeProvider: provider => after(call('provider-remove', { provider })),
    // After a failed turn: the Bot answers the user's last unanswered message, which is never sent again.
    resume: botId => after(call('resume', { botId })),
    // Escape hatch when continuous context overflow prevents auto-switching.
    newPart: (botId, sessionId) => after(call('new-part', { botId, ...(sessionId ? { sessionId } : {}) })),
    folders: () => call('folders'),
    folderPick: () => call('folder-pick'),
    folderList: path => call('folder-list', { path: path ?? '' }),
    setTeamWorkspace: path => after(call('team-workspace', { path })),
    deleteBot: id => after(call('delete-bot', { id })),
    releasePrivate: id => after(call('private-release', { id })),
    duplicateBot: id => after(call('duplicate-bot', { id })),
    setPrefs: prefs => after(call('set-prefs', prefs)),
    // Background pictures and a chat's own background (docs/plans/2026-11-21-appearance.md).
    addBackground: image => call('background-add', { image }),
    setChatBackground: body => after(call('set-chat-background', body)),
    setMain: (id, main = true, options = {}) => after(call('set-main', { id, main, ...options })),
    updateRoom: (id, patch) => after(call('update-room', { id, ...patch })),
    roomTodoCheck: (roomId, id, done) => after(call('room-todo', { roomId, id, done })),
    roomTodoRemove: (roomId, id) => after(call('room-todo', { roomId, id, action: 'remove' })),
    roomTodoClear: roomId => after(call('room-todo', { roomId, action: 'clear' })),
    send: (sessionId, text, options = {}) => after(call('send', {
      sessionId: partFor(sessionId),
      text,
      ...(options.images?.length ? { images: options.images } : {}),
      ...(options.files?.length ? { files: options.files } : {}),
    })),
    stageImage: (mediaType, data, name) => call('stage-image', { mediaType, data, ...(name ? { name } : {}) }),
    stageFile: (name, data, mediaType) => call('stage-file', { name, data, ...(mediaType ? { mediaType } : {}) }),
    stopChat: botId => after(call('stop-chat', { botId })),
    answerQuestion: (sessionId, questionId, answer) => after(call('answer-question', { sessionId: partFor(sessionId), questionId, answer })),
    dismissQuestion: sessionId => after(call('dismiss-question', { sessionId })),
    answerView: (sessionId, viewId, action, values) => after(call('view-reply', { sessionId: partFor(sessionId), viewId, action, values })),
    dismissView: sessionId => after(call('dismiss-view', { sessionId: partFor(sessionId) })),
    deleteBtw: (sessionId, cardId) => after(call('btw-delete', { sessionId, cardId })),
    answerApproval: (id, choice) => after(call('approval-answer', { id, choice })),
    computerSetEnabled: enabled => after(call('computer-set-enabled', { enabled })),
    computerSetLevel: (botId, level) => after(call('computer-set-level', { botId, level })),
    computerRevokeApp: (botId, appKey) => after(call('computer-revoke-app', { botId, appKey })),
    computerProviderRetry: () => after(call('computer-provider-retry', {})),
    computerSystemStatus: () => call('computer-system-status', {}),
    computerPermission: permission => call('computer-permission', { permission }),
    computerStop: (botId, all = false) => after(call('computer-stop', all ? { all: true } : { botId })),
    computerTakeover: botId => after(call('computer-takeover', { botId })),
    computerHandback: botId => after(call('computer-handback', { botId })),
    computerAllowForeground: botId => call('computer-allow-foreground', { botId }),
    computerAppAnswer: (id, answer) => after(call('computer-app-answer', { id, answer })),
    computerHoldAnswer: (botId, { callId, outcome } = {}) => after(call('computer-hold-answer', { botId, ...(callId !== undefined ? { callId } : {}), outcome })),
    computerShot: attachmentId => call('computer-shot', { attachmentId }),
    computerUserActive: idleSeconds => call('computer-user-active', { idleSeconds }),
    stopMemberWork: (roomId, botId) => after(call('stop-member-work', { roomId, botId })),
    stopRoomWork: roomId => after(call('stop-room-work', { roomId })),
    goalDraft: (roomId, text) => after(call('goal-draft', { roomId, text })),
    goalControl: (roomId, goalId, action, stopWork) => after(call('goal-control', { roomId, goalId, action, ...(stopWork ? { stopWork: true } : {}) })),
    // The group task board: the user's note is kept on the task and posted to the
    // group as a user message that calls its owner; cancelling is the panel's own.
    taskNote: (roomId, id, text) => after(call('task-note', { roomId, id, text })),
    taskCancel: (roomId, id) => after(call('task-cancel', { roomId, id })),
    // The goal / approval island: `goalCompose` holds the room whose draft form is
    // open, `goalOpen` the room whose goal panel is open, `approvalOpen` the room
    // whose approval panel is open. Goal and approval panels stay mutually exclusive.
    composeGoal: roomId => ui.set(state => ({ ...state, goalCompose: roomId, goalOpen: roomId, approvalOpen: null, taskDeck: null })),
    closeGoalCompose: () => ui.set(state => (state.goalCompose ? { ...state, goalCompose: null } : state)),
    toggleGoal: roomId => ui.set(state => ({
      ...state,
      goalOpen: state.goalOpen === roomId ? null : roomId,
      approvalOpen: state.goalOpen === roomId ? state.approvalOpen : null,
      taskDeck: state.goalOpen === roomId ? state.taskDeck : null,
    })),
    openGoal: roomId => ui.set(state => ({ ...state, goalOpen: roomId, approvalOpen: null, taskDeck: null })),
    closeGoal: () => ui.set(state => (state.goalOpen ? { ...state, goalOpen: null } : state)),
    toggleApproval: roomId => ui.set(state => ({
      ...state,
      approvalOpen: state.approvalOpen === roomId ? null : roomId,
      goalOpen: state.approvalOpen === roomId ? state.goalOpen : null,
      goalCompose: state.approvalOpen === roomId ? state.goalCompose : null,
      taskDeck: state.approvalOpen === roomId ? state.taskDeck : null,
    })),
    openApproval: roomId => ui.set((state) => {
      const snap = roster.getSnapshot()
      const activeSet = new Set(['running', 'waiting_work', 'waiting_approval'])
      const room = snap.roomsById?.[roomId]
      const bot = snap.byId?.[roomId]
      const hasTasks = room
        ? (room.members ?? []).some(id => (snap.byId?.[id]?.tasks ?? []).some(item => item?.roomId === room.id && activeSet.has(item.status)))
        : (bot?.tasks ?? []).some(item => !item?.roomId && activeSet.has(item.status))
      if (hasTasks) {
        return { ...state, taskDeck: { targetId: roomId, taskId: null, token: Date.now() }, approvalOpen: null, goalOpen: null, goalCompose: null }
      }
      return { ...state, approvalOpen: roomId, goalOpen: null, goalCompose: null, taskDeck: null }
    }),
    closeApproval: () => ui.set(state => (state.approvalOpen ? { ...state, approvalOpen: null } : state)),
    // Values go out in these requests and never come back in a response.
    secretSet: payload => after(call('secret-set', payload)),
    secretAllow: requestId => after(call('secret-allow', { requestId })),
    secretCancel: requestId => after(call('secret-cancel', { requestId })),
    secretUpdate: (name, { scope, purpose } = {}) => after(call('secret-update', { name, scope, purpose })),
    secretDelete: name => after(call('secret-delete', { name })),
    secretUnlock: passphrase => after(call('secret-unlock', { passphrase })),
    secretEncrypt: passphrase => after(call('secret-encrypt', { passphrase })),
    secretDecrypt: passphrase => after(call('secret-decrypt', { passphrase })),
    secretRefreshExternal: (providerId, resolve = false) => after(call('secret-refresh-external', { ...(providerId ? { providerId } : {}), ...(resolve ? { resolve: true } : {}) })),
    connectorConnect: (id, payload = {}) => after(call('connector-connect', { id, ...payload })),
    connectorDisconnect: id => after(call('connector-disconnect', { id })),
    connectorRetry: id => after(call('connector-retry', { id })),
    connectorSignInCode: (id, input) => after(call('connector-sign-in-code', { id, input })),
    connectorCancel: id => after(call('connector-cancel', { id })),
    connectorClient: (id, clientId, clientSecret) => after(call('connector-client', { id, clientId, clientSecret })),
    connectorSet: (id, patch) => after(call('connector-set', { id, ...patch })),
    connectorAdd: spec => after(call('connector-add', spec)),
    connectorRemove: id => after(call('connector-remove', { id })),
    connectorImportScan: () => call('connector-import-scan', {}),
    connectorImport: items => after(call('connector-import', { items })),
    connectorRequestCancel: requestId => after(call('connector-request-cancel', { requestId })),
    mailAccountAdd: payload => after(call('mail-account-add', payload)),
    mailAccountRemove: id => after(call('mail-account-remove', { id })),
    mailRuleSet: payload => after(call('mail-rule-set', payload)),
    mailSendAnswer: (requestId, choice, extra = {}) => after(call('mail-send-answer', { requestId, choice, ...extra })),
    mailSignInCode: payload => after(call('mail-sign-in-code', payload)),
    // DeepSeek's own document and speech services (api.deepseek.com/v1/tools/*), each
    // off until enabled. The status answer names the credential ref, never its value.
    deepseekServices: () => call('deepseek-services'),
    // absent keeps a field, null resets it; the full status comes back with the roster.
    setDeepseekServices: patch => after(call('deepseek-services-config', patch)),
    // One short piece of speech; the caller queues and plays the WAV it gets back.
    synthesizeSpeech: (body, signal) => call('deepseek-synthesize', body, signal),
    phoneSet: settings => after(call('phone-set', settings)),
    phonePair: () => after(call('phone-pair')),
    phonePairCancel: () => after(call('phone-pair-cancel')),
    phoneRemove: id => after(call('phone-remove', { id })),
    apiSet: settings => after(call('api-set', settings)),
    apiTokenCreate: payload => after(call('api-token-create', payload)),
    apiTokenUpdate: (keyId, patch) => after(call('api-token-update', { keyId, ...patch })),
    apiTokenRevoke: keyId => after(call('api-token-revoke', { keyId })),
    apiAudit: (options = {}) => after(call('api-audit', options)),
    apiAuditClear: () => call('api-audit-clear', {}),
    imAdd: payload => after(call('im-add', payload)),
    imUpdate: (id, patch) => after(call('im-update', { id, ...patch })),
    imRemove: id => after(call('im-remove', { id })),
    imPair: (id, senderId, allow) => after(call('im-pair', { id, senderId, allow })),
    imUnpair: (id, senderId) => after(call('im-unpair', { id, senderId })),
    imChat: (id, body) => after(call('im-chat', { id, ...body })),
    imRetry: id => after(call('im-retry', { id })),
    imLoginStart: payload => call('im-login-start', payload),
    imLoginWait: payload => call('im-login-wait', payload),
    saveCapability: capability => after(call('capability-save', capability)),
    deleteCapability: name => after(call('capability-delete', { name })),
    approveCapability: name => after(call('capability-approve', { name })),
    setBotCapability: (botId, name, attached, mode = 'always') => after(call('bot-capability', { botId, name, attached, mode })),
    pluginsList: (refresh = false) => call('plugins-list', { refresh }),
    pluginsCatalogRefresh: () => call('plugins-catalog-refresh', {}),
    pluginsInstall: body => after(call('plugins-install', body)),
    pluginsToggle: (id, enabled) => after(call('plugins-toggle', { id, enabled })),
    pluginsRemove: id => after(call('plugins-remove', { id })),
    pluginsUpdate: (id, version) => after(call('plugins-update', { id, ...(version ? { version } : {}) })),
    pluginsConsent: id => after(call('plugins-consent', { id })),
    pluginsSlotSet: (slot, id) => after(call('plugins-slot-set', { slot, id })),
    pluginsBotToggle: (id, botId, enabled) => after(call('plugins-bot-toggle', { id, botId, enabled })),
    pluginsCustomSave: body => after(call('plugins-custom-save', body)),
    pluginsSourceSave: body => after(call('plugins-source-save', body)),
    pluginsSourceRemove: id => after(call('plugins-source-remove', { id })),
    pluginsRetry: () => after(call('plugins-retry', {})),
    schedules: () => call('schedules'),
    scheduleEnable: () => call('schedule-enable'),
    scheduleCreate: task => call('schedule-create', task),
    scheduleDelete: (sessionId, id) => call('schedule-delete', { sessionId, id }),
    schedulePause: (sessionId, id, active) => call('schedule-pause', { sessionId, id, active }),
    exchange: (a, b) => call('exchange', { a, b }).catch(() => []),
    exchangeText: (id, a, b) => call('exchange-text', { id, ...(a !== undefined && b !== undefined ? { a, b } : {}) }).catch(() => undefined),
    fileText: file => call('file-text', { file }).catch(() => undefined),
    roomProgress: roomId => call('room-progress', { roomId }).catch(() => []),
    groupRows: (roomId, from, to, anchor) => call('group-rows', { roomId, from, ...(to === undefined ? {} : { to }), ...(anchor === undefined ? {} : { anchor }) }).catch(() => null),
    groupRelayReplies: (sessionId, preview) => call('group-relay-replies', { sessionId, preview }).catch(() => null),
    earlier: (sessionId, cursor) => call('earlier', { sessionId, cursor: cursor ?? null }),
    // Hours come back in this browser's time zone, so days start at local midnight.
    usage: () => call('usage', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    // The details panel's status line: turns, speed, cache hits and context for one Bot.
    runStats: botId => call('run-stats', { botId }),
    // `summarize` starts a summary when the entries changed; `regenerate` always does.
    memoryView: (id, flags = {}) => call('memory-view', { ...memoryOf(id), ...flags }),
    memoryAsk: (id, text) => call('memory-ask', { ...memoryOf(id), text }),
    memoryLayer: (id, entry, always) => call('memory-layer', { ...memoryOf(id), topic: entry.topic, text: entry.text, always }),
    memoryMove: (id, entry, to) => call('memory-move', { ...memoryOf(id), scope: entry.scope, topic: entry.topic, text: entry.text, to }),
    memoryTidyUndo: (id, scope, batch) => call('memory-tidy-undo', { ...memoryOf(id), scope, batch }),
    memoryPin: (id, entry, pin) => call('memory-pin', { ...memoryOf(id), scope: entry.scope, topic: entry.topic, text: entry.text, pin }),
    memoryForget: (id, entry) => call('memory-forget', { ...memoryOf(id), scope: entry.scope, topic: entry.topic, text: entry.text }),
    memoryHistory: (id, before) => call('memory-history', { ...memoryOf(id), ...(before === undefined ? {} : { before }) }),
    memoryRestore: (id, rowId) => call('memory-restore', { ...memoryOf(id), id: rowId }),
    diagnostics: payload => call('diagnostics', payload),
    diagnosticsLog: () => call('diagnostics-log'),
    diagnosticsClear: () => call('diagnostics-clear'),
    telemetryStatus: () => call('telemetry-status'),
    telemetryUpdate: patch => after(call('telemetry-update', patch)),
    telemetryResetId: () => call('telemetry-reset-id'),
    telemetryClearLog: () => call('telemetry-clear-log'),
    telemetryClientError: payload => call('telemetry-client-error', payload).catch(() => {}),
    repoStars: () => call('repo-stars'),
    // A failed action away from any form (a menu, the palette) shows as a toast.
    reportError: (error, where = 'action') => {
      noteClientError(where, error)
      ui.set(state => ({ ...state, toast: { text: error?.message ?? String(error), token: Date.now() } }))
    },
    // A message with no failure behind it (a review that expired, a window without the
    // column): a toast, but not in the client-error log.
    notice: text => ui.set(state => ({ ...state, toast: { text, token: Date.now() } })),
    dismissToast: token => ui.set(state => (state.toast && (token === undefined || state.toast.token === token) ? { ...state, toast: null } : state)),
    noteTurnTime: (sessionId, turn, key, time) => {
      if (sessionId === undefined || !Number.isFinite(turn) || !Number.isFinite(time)) return
      turnClock.set((state) => {
        const turns = state[sessionId] ?? {}
        const entry = turns[turn] ?? {}
        const next = key === 'first' && entry.first !== undefined ? Math.min(entry.first, time) : time
        if (entry[key] === next) return state
        return setTurnClock(state, sessionId, { ...turns, [turn]: { ...entry, [key]: next } })
      })
    },
    noteTurnPeer: (sessionId, turn, peerId) => {
      if (sessionId === undefined || !Number.isFinite(turn)) return
      turnClock.set((state) => {
        const turns = state[sessionId] ?? {}
        const entry = turns[turn] ?? {}
        if (entry.peer === peerId) return state
        return setTurnClock(state, sessionId, { ...turns, [turn]: { ...entry, peer: peerId } })
      })
    },
    noteLive: (sessionId, id, entry) => {
      if (sessionId === undefined) return
      live.set((state) => {
        const own = state[sessionId] ?? {}
        const prev = own[id]
        if (entry === null ? prev === undefined : prev !== undefined && JSON.stringify({ ...prev, at: 0 }) === JSON.stringify({ ...entry, at: 0 })) return state
        const next = { ...own }
        if (entry === null) delete next[id]
        else next[id] = { ...entry, at: prev?.at ?? Date.now() }
        return { ...state, [sessionId]: next }
      })
    },
    noteCards: (sessionId, callIds, delta) => {
      if (sessionId !== undefined) cards.set(state => countCards(state, sessionId, callIds, delta))
    },
    noteHeldCard: (sessionId, kind, requestId, delta) => {
      if (sessionId !== undefined) heldCards.set(state => countCards(state, sessionId, [heldCardKey(kind, requestId)], delta))
    },
    readQuestionDraft: (kind, id, subId) => questionDrafts?.readDraft(kind, id, subId) ?? '',
    noteQuestionDraft: (entry) => {
      if (!questionDrafts) return
      const chatId = entry.chatId ?? chatOfSession(roster?.getSnapshot?.(), entry.sessionId)?.id ?? null
      questionDrafts.noteDraft({ ...entry, chatId })
    },
    beginQuestionSettle: (kind, id, outcome) => questionDrafts?.beginSettle(kind, id, outcome),
    finishQuestionSettle: (kind, id, succeeded) => questionDrafts?.finishSettle(kind, id, succeeded),
    consumeRescuedDraft: (chatId, sessionId, taken) => questionDrafts?.consumeRescue(chatId, sessionId, taken),
    clearLive: sessionId => live.set((state) => {
      if (!state[sessionId]) return state
      const next = { ...state }
      delete next[sessionId]
      return next
    }),
  }
}

// Store-backed shared actions for unread marks, visits, reactions, sidebar prefs, and surface read.
export function createStoreActions({ store, clearPanelYieldOnToggle = false }) {
  return {
    surfaceMode: () => store.surface.getSnapshot().mode,
    setSidebarPref: pref => store.setSidebarPref(pref),
    setSidebarWidth: width => store.setSidebarWidth(width),
    toggleLeftHidden: () => store.toggleLeftHidden({ clearPanelYield: clearPanelYieldOnToggle }),
    setLeftDrawer: on => store.setLeftDrawer(on),
    setPanelYield: on => store.setPanelYield(on),
    markUnread: id => store.writeUnread(id, true),
    clearUnread: id => store.writeUnread(id, false),
    beginVisit: id => store.beginVisit(id),
    endVisit: id => store.endVisit(id),
    toggleReaction: (key, index, emoji) => store.toggleReaction(key, index, emoji),
  }
}

// Navigation sequence counter + shared retryOpening / recoverOpening / landOn orchestration.
export function createNavigationActions({
  call,
  after,
  pull,
  store,
  onRetry,
  onRecovered,
  onMissingAfterRecover,
  onLand,
  shouldAbortLand = null,
  canLandTarget = null,
  reportError,
}) {
  const { roster, partFor } = store
  let seq = 0
  const recovering = new Set()

  const bumpNavSeq = () => { seq += 1; return seq }
  const currentOfLast = (snap, last) => {
    if (!last) return undefined
    const bot = last.kind === 'room' ? undefined : snap.byId?.[last.botId ?? last.id]
    if (bot !== undefined) return currentPart(bot)
    const room = snap.roomsById?.[last.roomId ?? last.id]
    return room === undefined ? undefined : (room.sessionId ?? room.id)
  }

  return {
    bumpNavSeq,
    actions: {
      navSeq: () => seq,
      retryOpening: (target) => {
        if (!target) return
        onRetry(target)
      },
      recoverOpening: async (botId) => {
        if (!botId || recovering.has(botId)) return
        recovering.add(botId)
        const mySeq = ++seq
        try {
          await after(call('recover-session', { botId }))
          if (mySeq !== seq) return
          const bot = roster.getSnapshot().byId?.[botId]
          if (bot === undefined) {
            onMissingAfterRecover?.()
            return
          }
          onRecovered(currentPart(bot))
        } catch (error) {
          reportError?.(error, 'reopen-session')
        } finally {
          recovering.delete(botId)
        }
      },
      landOn: (id, last, expectedSeq) => {
        if (expectedSeq !== undefined && expectedSeq !== seq) return undefined
        const mySeq = ++seq
        if (!last && !shouldAbortLand) {
          const target = partFor(id)
          if (target && (!canLandTarget || canLandTarget(target, last))) onLand(target)
          return undefined
        }
        return (async () => {
          let moved = currentOfLast(roster.getSnapshot(), last)
          if (last && (moved === undefined || moved === last.sessionId)) {
            await pull().catch(() => {})
            if (mySeq !== seq) return
            moved = currentOfLast(roster.getSnapshot(), last)
          }
          if (mySeq !== seq) return
          if (shouldAbortLand?.(last)) return
          const target = moved !== undefined && moved !== last?.sessionId ? moved : partFor(id)
          if (!target) return
          if (canLandTarget && !canLandTarget(target, last)) return
          onLand(target)
        })()
      },
    },
  }
}

// Plugin, DSH, and standalone desktop app update polling + action orchestration.
export function createUpdateController({
  call,
  update,
  getAppUpdates = () => (globalThis.dshDesktop?.protocolVersion === 1 ? globalThis.dshDesktop.updates ?? null : null),
  getOwnAppUpdates = () => globalThis.dsBotApp?.updates ?? null,
}) {
  const mergeUpdate = (value) => {
    if (!value || typeof value !== 'object') return
    update.set(previous => ({ ...previous, ...value, app: previous.app, ownApp: previous.ownApp }))
  }
  let wakeUpdate = () => {}
  let scheduleUpdate = () => {}

  const start = () => {
    let stopped = false
    let updateTimer
    const nextDelay = value => (value?.phase === 'installing' || value?.dsh?.phase === 'installing' ? 2000 : 60 * 60_000)
    const arm = (value) => {
      clearTimeout(updateTimer)
      if (!stopped) updateTimer = setTimeout(() => { void pollUpdate() }, nextDelay(value))
    }
    const pollUpdate = async () => {
      clearTimeout(updateTimer)
      if (stopped) return
      const value = await call('update-check', { fresh: false }).catch(() => null)
      if (stopped) return
      mergeUpdate(value)
      arm(value)
    }
    wakeUpdate = () => { void pollUpdate() }
    scheduleUpdate = arm
    void pollUpdate()

    let unsubscribeApp = null
    const appUpdates = getAppUpdates()
    if (appUpdates?.status && appUpdates.subscribe) {
      const takeApp = (app) => { if (!stopped && app) update.set(previous => ({ ...previous, app })) }
      void Promise.resolve(appUpdates.status()).then(takeApp, () => {})
      unsubscribeApp = appUpdates.subscribe(takeApp)
    }

    let unsubscribeOwn = null
    const ownAppUpdates = getOwnAppUpdates()
    if (ownAppUpdates?.state && ownAppUpdates.subscribe) {
      const takeOwn = (ownApp) => { if (!stopped && ownApp) update.set(previous => ({ ...previous, ownApp })) }
      void Promise.resolve(ownAppUpdates.state()).then(takeOwn, () => {})
      unsubscribeOwn = ownAppUpdates.subscribe(takeOwn)
    }

    return () => {
      stopped = true
      clearTimeout(updateTimer)
      wakeUpdate = () => {}
      scheduleUpdate = () => {}
      unsubscribeApp?.()
      unsubscribeOwn?.()
    }
  }

  const actions = {
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
      const appUpdates = getAppUpdates()
      if (!appUpdates?.status) return
      const app = await appUpdates.status()
      if (app) update.set(previous => ({ ...previous, app }))
      if (sameVersion(app?.version, verified)) await appUpdates.open?.()
    },
    checkOwnApp: async () => { await getOwnAppUpdates()?.check?.() },
    installOwnApp: async () => { await getOwnAppUpdates()?.install?.() },
    openOwnApp: async () => { await getOwnAppUpdates()?.open?.() },
    downloadOwnApp: async () => { await getOwnAppUpdates()?.download?.() },
    setOwnAppAutoUpdate: async (enabled) => { await getOwnAppUpdates()?.setAutoUpdate?.(enabled === true) },
  }

  return { actions, start }
}

// Shared Bot Browser bridge controller (webview tabs, cookie import, host read-loop, retain).
export function createBrowserController({
  call,
  store,
  bridge = (globalThis.dshDesktop?.protocolVersion === 1 ? globalThis.dshDesktop.browser : globalThis.dsBotApp?.browser) ?? null,
  resolveOwner = null,
  extraRetainIds = () => [],
  yieldBrowser = () => true,
  onTabsEmptied = null,
  reconcileUi = null,
  onClosePanel = null,
}) {
  const { roster, ui } = store
  const browsers = bridge ? createBotBrowsers({ bridge, createSource }) : null
  const browserHolds = browsers?.holds ?? createSource({})
  const browserPages = browsers?.pages ?? createSource({})
  const browserTabs = browsers?.tabs ?? createSource({})

  const defaultResolveOwner = (id) => {
    const bot = id ? roster.getSnapshot().byId?.[id] : undefined
    return bot ? { ownerId: bot.id, detailsId: id, isClassic: false } : null
  }
  const ownerOf = resolveOwner ?? defaultResolveOwner

  const actions = {}
  if (browsers) {
    Object.assign(actions, {
      openBrowser: (id) => {
        const target = ownerOf(id)
        if (!target) return
        browsers.ensureTabs(target.ownerId)
        if (browsers.tabs.getSnapshot()[target.ownerId]?.active == null) browsers.openTab(target.ownerId)
        ui.set(state => ({
          ...state,
          inbox: false,
          details: target.detailsId,
          view: 'browser',
          renaming: false,
          tab: null,
          panelYield: yieldBrowser(state),
        }))
      },
      toggleBrowser: (id) => {
        const snap = roster.getSnapshot()
        if (snap.browser === false) return
        const target = ownerOf(id)
        if (!target) return
        const state = ui.getSnapshot()
        const sameOwner = target.isClassic
          ? (!snap.byId?.[state.details] && !snap.roomsById?.[state.details])
          : ((snap.byId?.[state.details]?.id ?? state.details) === target.ownerId)
        if (state.details && state.view === 'browser' && sameOwner) {
          onClosePanel?.()
          return
        }
        actions.openBrowser(target.toggleId ?? target.ownerId)
      },
      browserNewTab: (id) => {
        const target = ownerOf(id)
        if (!target) return null
        browsers.ensureTabs(target.ownerId)
        const tabId = browsers.openTab(target.ownerId)
        ui.set(state => ({
          ...state,
          inbox: false,
          details: target.detailsId,
          view: 'browser',
          renaming: false,
          tab: null,
          panelYield: yieldBrowser(state),
        }))
        return tabId
      },
      browserPick: (id, tabId) => {
        const target = ownerOf(id)
        if (!target) return
        browsers.activate(target.ownerId, tabId)
        ui.set(state => ({
          ...state,
          inbox: false,
          details: target.detailsId,
          view: 'browser',
          renaming: false,
          tab: null,
          panelYield: yieldBrowser(state),
        }))
      },
      browserEnsure: botId => browsers.ensureTabs(botId),
      browserCloseTab: onTabsEmptied
        ? async (botId, tabId) => {
            await browsers.closeTab(botId, tabId)
            const remaining = browsers.tabs.getSnapshot()[botId]
            if (remaining && remaining.ids.length > 0) return
            onTabsEmptied(botId)
          }
        : (botId, tabId) => browsers.closeTab(botId, tabId),
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

  const start = () => {
    if (!browsers) return () => {}
    let stopped = false
    let stopReads = null
    const sync = () => {
      if (stopped) return
      const snapshot = roster.getSnapshot()
      if (!snapshot.ready) return
      const on = snapshot.browser === true
      if (on && !stopReads) stopReads = serveBrowserReads({ browsers, post: call })
      if (!on && stopReads) { stopReads(); stopReads = null }
      const retainIds = [...snapshot.bots.map(bot => bot.id), ...extraRetainIds()]
      void Promise.resolve(browsers.retain(retainIds)).catch(() => {})
      if (reconcileUi) {
        reconcileUi(snapshot, on)
      } else {
        ui.set(state => (state.details && state.view === 'browser' && (!on || !snapshot.byId[state.details]) ? { ...state, view: 'details' } : state))
      }
    }
    sync()
    const offRoster = roster.subscribe(sync)
    return () => {
      stopped = true
      offRoster()
      stopReads?.()
      stopReads = null
      browsers.dispose()
    }
  }

  return {
    browsers,
    browserHolds,
    browserPages,
    browserTabs,
    actions,
    start,
  }
}

// Desktop computer-use bridge: floating indicator + tray rows, abortable cursor long-poll,
// OS idle-time sampling for foreground gate, and tray/indicator stop actions.
export function startComputerBridge({
  call,
  store,
  onStop,
  onAllowForeground,
  appComputer = globalThis.dsBotApp,
}) {
  if (!appComputer) return () => {}
  const { roster, computer } = store
  let stopped = false
  const cleanups = []

  if (typeof appComputer.computer === 'function') {
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
        if (entry.waitingFor === 'user-idle') {
          rows.push({
            botId,
            waiting: true,
            name: nameOf(botId),
            app: t('waits for the computer'),
            label: t('{name} waits for the computer', { name: nameOf(botId) }),
            color: look(botId).color,
            avatar: look(botId).image,
          })
        }
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

  if (typeof appComputer.computerCursor === 'function') {
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
        const ctrl = typeof AbortController === 'function' ? new AbortController() : null
        pollAbort = ctrl
        try {
          const reply = await call('computer-cursor-wait', { after }, ctrl?.signal)
          if (pollAbort === ctrl) pollAbort = null
          if (stopped || ctrl?.signal?.aborted) continue
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

  if (typeof appComputer.idleSeconds === 'function') {
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

  if (typeof appComputer.onComputerAction === 'function') {
    const offAction = appComputer.onComputerAction(({ kind, botId }) => {
      if (kind === 'stop') void onStop?.(botId, false)
      else if (kind === 'stopall') void onStop?.(null, true)
      else if (kind === 'letgo') void onAllowForeground?.(botId)
    })
    if (typeof offAction === 'function') cleanups.push(offAction)
  }

  return () => {
    stopped = true
    for (const cleanup of cleanups) cleanup()
  }
}

// Canonical settings page ids recognized by `selectPanel` in standalone mode.
export const SETTINGS_PANEL_IDS = new Set([
  'overview', 'general', 'shortcuts', 'appearance',
  'models', 'local-agents', 'bot-models', 'deepseek-services',
  'bots', 'groups', 'schedules',
  'connectors', 'im', 'phone', 'api',
  'computer', 'browser', 'capabilities', 'secrets',
  'plugins', 'usage', 'about', 'privacy', 'feedback',
])

// Shared action assembler: builds the complete shared-view action surface from
// team-core controllers plus narrow host callbacks, so neither adapter defines
// shared-view actions directly.
export function assembleTeamActions({
  call,
  after,
  store,
  foldWrites,
  panelFolded,
  nav,
  updateCtrl,
  browserCtrl,
  clearPanelYieldOnToggle = false,
  host = {},
  extra = {},
}) {
  const { roster, ui, live, cards, heldCards, turnClock, questionDrafts, partFor } = store
  const baseActions = teamActions({
    call,
    after,
    partFor,
    roster,
    ui,
    live,
    cards,
    heldCards,
    turnClock,
    panelFolded,
    questionDrafts,
    foldWrites,
  })
  const storeActions = createStoreActions({ store, clearPanelYieldOnToggle })

  const actions = {
    ...baseActions,
    ...storeActions,
    ...nav.actions,
    ...updateCtrl.actions,
    ...browserCtrl.actions,

    closePanel: () => {
      baseActions.closePanel()
      host.afterClosePanel?.()
    },
    closeOverlay: () => {
      const hadDialog = Boolean(ui.getSnapshot().newChat || ui.getSnapshot().exchange)
      baseActions.closeOverlay()
      if (!hadDialog) host.afterCloseOverlay?.()
    },
    toggleDetails: (id, force) => {
      baseActions.toggleDetails(id, force)
      host.afterToggleDetails?.()
    },

    openChanges: async (changes) => {
      if (changes === null || typeof changes !== 'object'
        || typeof changes.sessionId !== 'string'
        || !Number.isInteger(changes.seq)
        || (host.requireChangesTurn === true && !Number.isInteger(changes.turn))) return
      let available = false
      try { available = (await call('changes-check', { sessionId: changes.sessionId, seq: changes.seq })) === true } catch { available = false }
      if (!available) { actions.notice(t('These changes are no longer available')); return }
      await host.openChanges?.(changes, actions)
    },

    steerQueued: async (sessionId) => {
      if (!sessionId || typeof host.steerQueued !== 'function') return
      const tryBotBatch = async (ids) => {
        if (roster.getSnapshot().byId?.[sessionId] === undefined) return 'fallback'
        try {
          const result = await actions.steerQueueBatch(sessionId, ids)
          return result?.fallback === true ? 'fallback' : 'done'
        } catch (error) {
          return error?.code === 'bot/not-found' ? 'fallback' : 'failed'
        }
      }
      const reportSteerError = () => {
        actions.reportError(new Error(t('Couldn’t steer the queued messages. Try again.')), 'steer-queue')
      }
      await host.steerQueued(sessionId, { tryBotBatch, reportSteerError, actions })
    },

    isAgentSession: id => Boolean(host.isAgentSession?.(id)),
    openSession: (id) => {
      if (host.isAgentSession?.(id)) return actions.openAgentSession(id)
      nav.bumpNavSeq()
      const target = partFor(id)
      const fromInbox = ui.getSnapshot().inbox === true
      return host.openTeamSession?.({ id, target, fromInbox, actions })
    },
    openAgentSession: sessionId => host.openAgentSession?.(sessionId, { nav, actions }),
    setSurface: mode => host.setSurface?.(mode, { actions }),

    addAgent: (...args) => host.agent?.addAgent?.(...args),
    openAgent: (...args) => host.agent?.openAgent?.(...args),
    newAgentSession: (...args) => host.agent?.newAgentSession?.(...args),
    archiveAgentSession: (...args) => host.agent?.archiveAgentSession?.(...args),
    renameAgentSession: (...args) => host.agent?.renameAgentSession?.(...args),
    removeAgent: (...args) => host.agent?.removeAgent?.(...args),

    selectPanel: id => host.selectPanel?.(id, actions),
    toggleSidebar: () => (host.toggleSidebar ? host.toggleSidebar(actions) : actions.toggleLeftHidden()),
    setSidebarWide: next => (host.setSidebarWide ? host.setSidebarWide(next, actions) : actions.setSidebarPref(next ? 'open' : 'hidden')),

    canOpenFiles: () => Boolean(host.canOpenFiles?.()),
    openFiles: () => host.openFiles?.(actions),
    canOpenTerminal: () => Boolean(host.canOpenTerminal?.()),
    newTerminal: () => host.newTerminal?.(actions),
    watchAgentTerminals: sessionId => host.watchAgentTerminals?.(sessionId, actions),

    canReferenceChat: () => Boolean(host.canReferenceChat?.()),
    referenceChat: (sessionId, arg) => host.referenceChat?.(sessionId, arg),

    speech: () => host.speech?.(),
    voiceSetup: providerId => host.voiceSetup?.(providerId) ?? null,
    closingReply: (sessionId, turn) => host.closingReply?.(sessionId, turn),
    turnFacts: sessionId => host.turnFacts?.(sessionId),
    watchTurns: (sessionId, listener) => host.watchTurns?.(sessionId, listener) ?? (() => {}),

    draftFiles: ids => host.drafts?.draftFiles?.(ids) ?? [],
    restoreDraftFiles: (sessionId, files) => host.drafts?.restoreDraftFiles?.(sessionId, files) ?? [],
    releaseDraftFiles: ids => host.drafts?.releaseDraftFiles?.(ids),

    signInEntry: () => host.account?.signInEntry?.() ?? null,
    canSignIn: () => Boolean(host.account?.canSignIn?.()),
    accountT: () => host.account?.accountT?.() ?? (key => key),

    holdSettingsLook: () => (host.holdSettingsLook ? host.holdSettingsLook() : () => {}),

    ...extra,
  }

  return actions
}
