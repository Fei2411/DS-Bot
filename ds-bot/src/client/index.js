import { call } from './api.js'
import { isHex, inkText, paintCss } from './inks.js'
import { DEFAULT_MASK, SHAPES, markupCache, maskOf } from './characters.js'
import {
  createBrowserController,
  createNavigationActions,
  createSource,
  createStoreActions,
  createTeamPull,
  createTeamStore,
  createUpdateController,
  isAgentSession,
  ownerOfSession as resolveSessionOwner,
  pruneRemovedChatDrafts,
  sectionFoldWrites,
  startComputerBridge,
  teamActions,
} from './team-core/index.js'
import { themeCss, shellTokens, surfaceColors, registry, registerShape, registerTheme, allThemes, themesOf, layoutOf, effectsOf, widthOf, flatWidthOf } from './themes.js'
import { appearanceCss, backgroundShown, onSafeAppearance, pictureUrl, safeAppearance, userCss, watchSafeAppearance } from './appearance.js'
import { dshAppearanceCss } from './appearance-dsh.js'
import { readSkinSurfaceVars, writeSkinSurfaceVars } from './skin.js'
import { MENTION_ORIGIN, currentPart } from './text.js'
import { SHELL_CSS, CONVERSATION_CSS, botOwnCss, installStyles, installLastStyles, installCompiledStyles, RETURN_TOKENS } from './styles.js'
import { DSH_CONVERSATION_CSS, DSH_SHELL_CSS, dshThemeCss } from './styles-dsh.js'
import { installDshAdapter } from './adapter-dsh.js'
import { lookOf } from './mark.js'
import { TeamSidebar, YouAvatar, AccountLauncher, FooterAccount, BrandMark, BrandName, BotReturn, SIDEBAR_CSS, RETURN_CSS, holdShellShortcuts } from './sidebar.js'
import { installSettingsShell, SETTINGS_SHELL_CSS } from './settings-shell.js'
import { frameLayout, DSH_NARROW } from './frame-layout.js'
import { installFrameWatch } from './frame-watch.js'
import { HeaderPill } from './header.js'
import { watchAgentTerminals } from './agent-terminals.js'
import { ComposerPlus, ComposerVoice, DraftKeeper, menuIcons } from './composer.js'
import { CHATS_SOURCE, atSources } from './at-menu.js'
import { BtwDock, BtwTurnTail } from './btw.js'
import { SIDE_CSS, sideSource } from './side-chat.js'
import { VOICE_BUNDLE, closingReplyText, requestPreparation } from './speech.js'
import { QuestionCard, QuestionDock } from './questions.js'
import { AnsweredReply, WidgetDock, WIDGET_CSS } from './widget-cell.js'
import { CHANGES_CSS } from './changes-card.js'
import { HandoffDock, HANDOFF_CSS } from './handoff-card.js'
import { WorkPauseDock } from './work-pause-card.js'
import { AppAccessDock, ComputerHandoffDock, ComputerIndicator, COMPUTER_CSS } from './computer.js'
import { installHeaderNavigation } from './header-navigation.js'
import { AssistantCell, TriggerCell, TurnProcessCell, Nothing, CellEmpty, TurnTailCell, ToolCell } from './cells.js'
import { SaveFileAction } from './file-save.js'
import { fileMentionSource } from './mention-source.js'
import { FailureCell, TURN_ERROR_CSS } from './turn-error.js'
import { Overlays } from './overlays.js'
import { BROWSER_CSS } from './browser-pane.js'
import { SECRET_CSS, SecretDock } from './secret-card.js'
import { ConnectorDock, MailDock, CONNECTOR_CSS } from './connectors.js'
import { CONNECTORS_PAGE_CSS } from './connectors-page.js'
import { PROVIDERS_CSS } from './providers-page.js'
import { LearningDock, LearningTurnTail, PendingLearning, LEARNING_CSS } from './learning-card.js'
import { MODEL_CSS, ModelChoiceDock, DeepSeekSignIn } from './model-menu.js'
import { AGENT_PRESET_CSS } from './agent-preset-menu.js'
import { BOT_SETTINGS_CSS } from './bot-settings.js'
import { BOT_MODELS_CSS } from './bot-models-page.js'
import { AGENT_CARDS_CSS } from './agent-cards.js'
import { AVATAR_LIBRARY_CSS } from './avatar-library.js'
import { GROUP_SETTINGS_CSS } from './group-settings.js'
import { FOLDER_CSS } from './folder-menu.js'
import { USAGE_CSS } from './usage-page.js'
import { SCHEDULE_CSS } from './schedules.js'
import { APPEARANCE_PAGE_CSS } from './appearance-page.js'
import { SHORTCUTS_PAGE_CSS } from './shortcuts-page.js'
import { registerPluginShortcuts } from './plugin-shortcuts.js'
import { STORAGE } from './storage.js'
import { freePriority, groupsFor, surfaceGroups, writeMode } from './surface.js'
import './locales/all.js'
import { installLocale, t } from './i18n.js'
import { noteClientError, quietly } from './diagnostics.js'
import { steerQueued } from './enter-steer.js'
import { installCommandActions } from './command-actions.js'
import { RIGHTBAR_ATTRIBUTES, columnOpened, createSwitchWindow, drawerOpened, rightColumnOpen } from './right-panel.js'
import { ErrorToast, FEEDBACK_CSS } from './feedback.js'
import { PRIVACY_CSS } from './privacy-page.js'
import { ABOUT_CSS } from './about.js'
import { INBOX_CSS } from './inbox.js'
import { MEMBER_CSS, MemberDock } from './member-status.js'
import { TASK_CSS } from './task-board.js'
import { IM_CSS } from './im-page.js'
import { GOAL_CSS } from './goal.js'
import { TASKS_CSS } from './bot-tasks.js'
import { BotMention, USER_MESSAGE_CSS, UserMessageCell, canDrawUserMessages, installUserBubble } from './user-message.js'
import { BOT_MENTION_ID, installBotMentionRule } from './user-text-rule.js'
import { QueueDock, QUEUE_CSS } from './queue-dock.js'
import { PASTE_CSS } from './paste-card.js'
import { DSH_PASTE_CSS, PasteDock, PasteGuard } from './paste-card-dsh.js'
import { OPENING_CSS, bindOpeningWait } from './opening.js'
import { noticeApprovals } from './approval-notices.js'
import { listedOpener } from './open-listed.js'
import { installTitle } from './branding.js'
import { pollDelay } from './polling.js'
import { installMotionRest } from './motion-rest.js'
import { agentSessionToReuse, singleFlight } from './agent-new.js'
import { TextSelectionAction, ANNOTATION_CSS } from './text-annotation.js'
import { installAgentForks } from './agent-fork.js'
import { watchBotCompletions } from './bot-completions.js'
import { callServiceMethod, createSessionStatusSource, hasContextProperty, readServiceMember } from './host-service.js'

export const inject = ['sessions', 'uiWorkspace', 'uiConversation', 'uiSession', 'slots', 'theme', 'layout']

const WINDOWS = globalThis.navigator?.userAgentData?.platform === 'Windows' || /^Win/u.test(globalThis.navigator?.platform ?? '')

export function apply(ctx) {
  ctx.effect(() => installTitle(document), 'ds-bot: window title')
  // Install synchronously when `locale` is already active so cold-start `state` pulls
  // and desktop tray labels use the user's language on the first tick, while the child
  // `ctx.inject(['locale'], ...)` fiber handles late arrival and reloads.
  ctx.effect(() => {
    const initialLocale = ctx.get('locale')
    let offInitial = initialLocale ? installLocale(initialLocale) : null
    const releaseInitial = () => {
      const off = offInitial
      offInitial = null
      off?.()
    }
    const fiber = ctx.inject(['locale'], (scope) => {
      scope.effect(() => {
        releaseInitial()
        return installLocale(scope.locale)
      }, 'ds-bot: interface copy')
    })
    return () => {
      releaseInitial()
      return fiber.dispose()
    }
  }, 'ds-bot: interface copy lifecycle')
  const sessionStatus = createSessionStatusSource(ctx)
  ctx.effect(() => () => sessionStatus.dispose(), 'ds-bot: session status')
  const PREFS_KEY = STORAGE.prefs
  // Bot mode paints the whole team surface; Agent mode withdraws every slot and
  // style so the shell's own interface returns. `plain` stays false until a Bot-mode
  // view hosts a plain session, which drops only the conversation replacements.
  const store = createTeamStore({ surfaceExtra: { plain: false } })
  const {
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
    frame,
    questionDrafts,
    partFor,
  } = store
  // Whether DS Bot holds the settings seat; Overlays draws the Settings dialog while it does not.
  const settingsShellHeld = createSource(false)
  let settingsShell = null
  // DSH Agent Session ids from the last pull, so a reload already knows the main
  // view is a plain Session before the team answers.
  let agentSessionCache = new Set()
  try { agentSessionCache = new Set(JSON.parse(localStorage.getItem(STORAGE.agentSessions) ?? '[]')) } catch { agentSessionCache = new Set() }
  // Sessions adopted on this window (workspace pick, fork) but not yet in the roster.
  const pendingAdopt = new Map()
  // A create can finish before the DSH list publishes its Session (#1225).
  const pendingAgentSession = new Map()
  const agentNewInFlight = new Map()
  const isAgentSessionId = id => isAgentSession(roster.getSnapshot(), agentSessionCache, id) || pendingAdopt.has(id)
  const agentOfSession = id => roster.getSnapshot().agentOf[id] ?? pendingAdopt.get(id)
  // The workspace a Session lives in, for follow-up creates and switch detection.
  const workspaceOf = (sessionId) => {
    const items = readServiceMember(ctx, 'workspaces', 'list')?.getSnapshot()?.items ?? []
    return items.find(item => item.sessionIds?.includes(sessionId))?.workspaceId
  }
  // A navigation this plugin started: the surface effect trusts the id it lands on.
  let expected = null
  const setPlain = (plain) => surface.set(state => (state.plain === plain ? state : { ...state, plain }))
  // A DSH Agent Session shows the plain conversation: the Bot details and browser
  // panels would follow it and report it is not on the team, so they close.
  const dropPanels = () => ui.set(state => (state.details || state.renaming ? { ...state, details: null, view: 'details', renaming: false, tab: null } : state))
  // Unread marks, reactions, visits and rescued drafts stay synced across windows and pagehide.
  ctx.effect(() => store.attachWindowListeners(window), 'ds-bot: follow other windows and visits')
  const refreshed = new Set()
  const foldWrites = sectionFoldWrites()
  const { pull, reset: resetPull } = createTeamPull({
    call,
    store,
    foldWrites,
    onChatsRemoved: (gone) => { pruneRemovedChatDrafts(gone, questionDrafts) },
    onHydrated: (indexed) => {
      try {
        const ids = (indexed.agents ?? []).flatMap(agent => agent.sessions ?? [])
        localStorage.setItem(STORAGE.agentSessions, JSON.stringify(ids))
        agentSessionCache = new Set(ids)
      } catch { /* storage unavailable */ }
      // Adopted ids are known by the roster now; ones gone from the list were archived.
      const listed = ctx.sessions.list.getSnapshot().byId ?? {}
      for (const id of pendingAdopt.keys()) {
        if (indexed.agentOf[id] !== undefined || listed[id] === undefined) pendingAdopt.delete(id)
      }
      for (const [agentId, sessionId] of pendingAgentSession) {
        if (listed[sessionId] !== undefined || indexed.agentOf[sessionId] !== agentId) pendingAgentSession.delete(agentId)
      }
      const activeIds = new Set([...indexed.bots.map(currentPart), ...indexed.rooms.map(room => room.sessionId ?? room.id)])
      for (const id of refreshed) {
        if (!activeIds.has(id)) refreshed.delete(id)
      }
      for (const id of activeIds) {
        if (refreshed.has(id)) continue
        refreshed.add(id)
        void Promise.resolve(ctx.sessions.refreshProjections?.(id)).catch(quietly('refresh projections'))
      }
    },
  })

  ctx.effect(() => {
    let stopped = false
    let running = false
    let timer
    let misses = 0
    // While the host keeps answering that nothing changed, asking every 1.5 s only makes
    // the renderer serialise requests and compare answers (#1462). The wait stretches to
    // POLL_MAX_MS and snaps back on the first change, a wake, or any action's own pull.
    let unchanged = 0
    const loop = async () => {
      clearTimeout(timer)
      if (running || stopped) return
      running = true
      try {
        unchanged = await pull() ? 0 : unchanged + 1
        misses = 0
        // A late-arriving API clears the failure the misses reported.
        ui.set(state => (state.bootFailed ? { ...state, bootFailed: false } : state))
      } catch (error) {
        if (!stopped) {
          console.warn('[ds-bot] state', error)
          // Only a missing Bot API counts toward a failed start: while the
          // host plugin stays unmounted the route answers 404. A network miss
          // is the host reconnecting, not a start-up failure (#516).
          if (error?.code === 'HTTP_404') {
            misses += 1
            if (misses >= 10 && !roster.getSnapshot().ready) ui.set(state => (state.bootFailed ? state : { ...state, bootFailed: true }))
          }
        }
      } finally { running = false }
      if (!stopped) timer = setTimeout(loop, pollDelay(document.hidden ? 10000 : 1500, unchanged))
    }
    const wake = () => { if (!document.hidden) { unchanged = 0; void loop() } }
    document.addEventListener('visibilitychange', wake)
    void loop()
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener('visibilitychange', wake) }
  }, 'ds-bot: roster poll')

  // Plugin, DSH, and DS Bot app update polling + actions live in team-core.
  const updateCtrl = createUpdateController({
    call,
    update,
    getAppUpdates: () => (window.dshDesktop?.protocolVersion === 1 ? window.dshDesktop.updates ?? null : null),
    getOwnAppUpdates: () => globalThis.dsBotApp?.updates ?? null,
  })
  ctx.effect(() => updateCtrl.start(), 'ds-bot: update check')

  // Whether the open Bot panel is folded away for lack of room: its opener then
  // means "show it" (the column yields), not "close it". A panel shown because
  // the column already yielded is not folded, so its opener closes it.
  const panelFolded = (view) => {
    const state = ui.getSnapshot()
    const f = frame.getSnapshot()
    return frameLayout({ viewport: f.viewport, sidebarWidth: f.sidebarWidth, pref: sidebarPref.getSnapshot(), drawer: state.leftDrawer, panel: { view: view ?? state.view, yielded: state.panelYield === true } }).panel === 'folded'
  }
  const yieldBrowser = state => state.panelYield === true || panelFolded('browser')

  // Bot browsers need a webview bridge: DSH Desktop's, or the desktop app's of the
  // same shape. The host serves read_browser only in those two (`browser` in the state).
  const browserBridge = (window.dshDesktop?.protocolVersion === 1 ? window.dshDesktop.browser : globalThis.dsBotApp?.browser) ?? null
  const browserCtrl = createBrowserController({
    call,
    store,
    bridge: browserBridge,
    yieldBrowser,
    onClosePanel: () => actions.closePanel(),
  })
  const { browserPages, browserTabs, browserHolds } = browserCtrl
  if (browserCtrl.browsers) {
    ctx.effect(() => browserCtrl.start(), 'ds-bot: Bot browsers')
  }

  ctx.effect(() => () => { markupCache.clear(); resetPull() }, 'ds-bot: character markup')
  ctx.effect(() => installMotionRest(), 'ds-bot: motion rest')

  // Mentions wear each Bot's color and character silhouette (or its photo). User text
  // DSH draws (a message waiting to be sent or to join a running turn, and since DSH
  // 0.2.1-alpha.3 the contents of DS Bot's own user bubble, .bt-uhost) shows "@Name" as
  // a file reference; one whose label is a whole Bot name wears the Bot's mark there too
  // (a name with a space is cut by DSH, so it stays as DSH draws it).
  const installMentions = () => {
    const style = installStyles('', 'mentions')
    let last = ''
    let lastReg = null
    let lastSig = null
    const render = () => {
      const reg = registry.getSnapshot()
      const bots = roster.getSnapshot().bots
      if (lastSig !== null && reg === lastReg && bots.length === lastSig.length && bots.every((b, i) => {
        const prev = lastSig[i]
        return prev[0] === b.id
          && prev[1] === b.name
          && prev[2] === b.color
          && prev[3] === b.avatar?.shape
          && prev[4] === b.avatar?.color
          && prev[5] === b.avatar?.image
      })) return
      lastReg = reg
      lastSig = bots.map(b => [b.id, b.name, b.color, b.avatar?.shape, b.avatar?.color, b.avatar?.image])
      const next = bots.map((bot) => {
        const anchor = `.bt-bubble a[href="${MENTION_ORIGIN}${bot.id}"]`
        const chip = /\s/.test(bot.name) ? '' : `:is([class*="_userRow"],.bt-uhost) [data-ref-chip="file"][title="@${bot.name.replace(/["\\]/g, '\\$&')}" i]`
        const look = lookOf(bot)
        const marks = chip ? `${anchor}::before,${chip}::before` : `${anchor}::before`
        const mark = look.image
          ? `${marks}{background:center/cover url("${look.image}");-webkit-mask:none;mask:none;border-radius:50%}`
          : `${marks}{background:${paintCss(look.color)};-webkit-mask-image:${maskOf(look.shape)};mask-image:${maskOf(look.shape)}}`
        const chipBase = chip ? `${chip}{color:inherit;font-weight:600}${chip}>svg{display:none}${chip}::before{content:"";display:inline-block;flex:none;width:16px;height:16px;margin-right:3px;vertical-align:-3px;-webkit-mask:${DEFAULT_MASK} center/contain no-repeat;mask:${DEFAULT_MASK} center/contain no-repeat}` : ''
        return `${anchor}{color:${inkText(look.color)}}${chipBase}${mark}`
      }).join('\n')
      if (next !== last) style.textContent = last = next
    }
    render()
    const offRoster = roster.subscribe(render)
    const offRegistry = registry.subscribe(render)
    return () => { offRoster(); offRegistry(); style.remove() }
  }

  // The chosen theme lives in the team state so every device shares it; the local
  // copy only avoids a flash of the default theme before the first state pull.
  // The Session the main view holds open, if any.
  const shownSessionId = () => Object.values(ctx.sessions.list.getSnapshot().byId ?? {}).find(session => (session?.retainedBy?.mainView ?? 0) > 0)?.id
  const installTheme = () => {
    const style = installStyles('', 'theme')
    // The appearance, and the user's own stylesheet after every DS Bot sheet.
    const look = installStyles('', 'appearance')
    const userSheet = installLastStyles('user-stylesheet')
    let key = ''
    let releaseTokens = null
    let activeTheme = null
    // A third-party skin's glass sliders change DSH's background tokens; the surfaces
    // follow them through --bt-skin-*, and nothing is set while the tokens are opaque.
    // DS Bot's own background sets the panes itself (appearance.js); the skin bridge then stays out.
    let ownBackground = false
    const skin = writeSkinSurfaceVars(document, () => (activeTheme === null || ownBackground ? {} : readSkinSurfaceVars(document, activeTheme)))
    let skinRaf = 0
    const scheduleSkin = () => {
      if (skinRaf) return
      if (typeof requestAnimationFrame === 'function') skinRaf = requestAnimationFrame(() => { skinRaf = 0; skin.apply() })
      else skin.apply()
    }
    const offTheme = ctx.on('theme/change', () => skin.apply())
    const isTitleOnly = (record) => {
      const target = record.target
      const el = target?.nodeType === 1 ? target : target?.parentElement
      if (el?.tagName === 'TITLE') return true
      if (record.type === 'childList' && target === document.head) {
        const nodes = [...record.addedNodes, ...record.removedNodes]
        if (nodes.length > 0 && nodes.every(node => node?.nodeType === 1 && node.tagName === 'TITLE')) return true
      }
      return false
    }
    // A skin may write the tokens itself (some set them straight on the document); the
    // composed value is what counts, so re-read whenever the tokens may have moved.
    const observer = typeof MutationObserver === 'function' ? new MutationObserver((records) => {
      if (records.length > 0 && records.every(isTitleOnly)) return
      scheduleSkin()
    }) : null
    if (observer !== null) {
      observer.observe(document.body, { attributes: true, attributeFilter: ['style', 'data-ds-dark-theme'] })
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] })
      observer.observe(document.head, { childList: true, subtree: true, characterData: true })
    }
    const render = () => {
      const snapshot = roster.getSnapshot()
      const prefs = snapshot.ready ? snapshot.prefs ?? {} : savedPrefs
      const themes = themesOf(prefs)
      const id = themes[prefs.theme] ? prefs.theme : 'deepseek'
      // The open chat's own background, over the team's (docs/plans/2026-11-21-appearance.md).
      const open = shownSessionId()
      const chat = open === undefined ? undefined : snapshot.byId?.[open] ?? snapshot.roomsById?.[open]
      const safe = safeAppearance()
      const lookCss = [
        appearanceCss({ appearance: prefs.appearance, theme: themes[id], background: chat?.background, pictureUrl: picture => pictureUrl(picture, call, render), safe, user: false }),
        dshAppearanceCss({ appearance: prefs.appearance, fonts: false }),
      ].filter(Boolean).join('\n')
      if (look.textContent !== lookCss) look.textContent = lookCss
      const mine = userCss(prefs.appearance, safe)
      if (userSheet.textContent !== mine) userSheet.textContent = mine
      const through = backgroundShown({ appearance: prefs.appearance, background: chat?.background, pictureUrl: picture => pictureUrl(picture, call, render), safe })
      ownBackground = through
      const accent = isHex(prefs.accent) ? prefs.accent : undefined
      const motion = prefs.motion === 'quiet' || prefs.motion === 'lively' ? prefs.motion : 'normal'
      const layout = layoutOf(prefs)
      const effects = effectsOf(prefs)
      const width = widthOf(prefs)
      const flatWidth = flatWidthOf(prefs)
      const next = `${id}|${JSON.stringify(themes[id])}|${accent ?? ''}|${motion}|${layout}|${effects}|${width}|${flatWidth}|${through}|${registry.getSnapshot()}`
      if (next === key) return
      key = next
      if (document.body.dataset.btMotion !== motion) document.body.dataset.btMotion = motion
      if (document.body.dataset.btLayout !== layout) document.body.dataset.btLayout = layout
      if (document.body.dataset.btEffects !== effects) document.body.dataset.btEffects = effects
      if (WINDOWS && document.body.dataset.btOs !== 'windows') document.body.dataset.btOs = 'windows'
      const msgW = String(width / 100)
      if (document.body.style.getPropertyValue('--bt-msg-w') !== msgW) document.body.style.setProperty('--bt-msg-w', msgW)
      const flatW = String(flatWidth / 100)
      if (document.body.style.getPropertyValue('--bt-flat-w') !== flatW) document.body.style.setProperty('--bt-flat-w', flatW)
      style.textContent = themeCss(themes[id], accent) + dshThemeCss(themes[id])
      activeTheme = themes[id]
      skin.apply()
      const release = releaseTokens
      releaseTokens = ctx.theme.overrideTokens('ds-bot', shellTokens(themes[id], through ? surfaceColors(themes[id]) : undefined))
      if (typeof release === 'function') release()
      if (snapshot.ready) {
        try { localStorage.setItem(PREFS_KEY, JSON.stringify({ theme: prefs.theme, accent: prefs.accent, motion: prefs.motion, layout: prefs.layout, effects: prefs.effects, width: prefs.width, flatWidth: prefs.flatWidth, thinking: prefs.thinking, defaultBotModel: prefs.defaultBotModel, enterToSend: prefs.enterToSend })) } catch { /* storage unavailable */ }
      }
    }
    render()
    const offRoster = roster.subscribe(render)
    const offRegistry = registry.subscribe(render)
    const offShown = ctx.sessions.list.subscribe(render)
    const offSafe = onSafeAppearance((on) => {
      render()
      if (on) actions.notice?.(t('Safe appearance: the background and your stylesheet are off in this window. Turn them back on in Settings → Appearance.'))
    })
    const stopSafe = watchSafeAppearance()
    return () => {
      offRoster()
      offRegistry()
      offShown()
      offSafe()
      stopSafe()
      look.remove()
      userSheet.remove()
      offTheme()
      if (skinRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(skinRaf)
      observer?.disconnect()
      skin.clear()
      try {
        if (typeof releaseTokens === 'function') releaseTokens()
      } finally {
        delete document.body.dataset.btMotion
        delete document.body.dataset.btLayout
        delete document.body.dataset.btEffects
        delete document.body.dataset.btOs
        document.body.style.removeProperty('--bt-msg-w')
        document.body.style.removeProperty('--bt-flat-w')
        style.remove()
      }
    }
  }

  ctx.effect(() => {
    const hub = { registerShape, registerTheme, themes: () => Object.keys(allThemes()), shapes: () => Object.keys(SHAPES) }
    const queued = Array.isArray(window.dshBotQueue) ? window.dshBotQueue : []
    window.dshBot = hub
    window.dshBotQueue = { push: (task) => { try { task(hub) } catch (error) { console.warn('[ds-bot] registration', error); noteClientError('registration', error) } } }
    for (const task of queued) window.dshBotQueue.push(task)
    return () => {
      if (window.dshBot === hub) delete window.dshBot
      delete window.dshBotQueue
    }
  }, 'ds-bot: registry')

  ctx.inject(['shortcuts'], scope => { scope.effect(() => holdShellShortcuts(scope.shortcuts), 'ds-bot: settings shortcut') })

  // DSH's own changes-review tab opens by resource address in the right column. A window
  // without that column never provides the service; the change row then says it cannot
  // open the review instead of doing nothing.
  let openReview
  ctx.inject(['sidebarRight'], (scope) => {
    openReview = changes => scope.sidebarRight.openResource(`dsh-resource://changes-review/session/${encodeURIComponent(changes.sessionId)}/${changes.seq}/${changes.turn}`)
    scope.effect(() => () => { openReview = undefined }, 'ds-bot: change review opener')
  })
  // The one jump into the review: DSH's tab belongs to the Session the shell shows, so the
  // member's Session opens first, and the tab is asked for once its column is mounted.
  // Keeping it here means a future review that can stay in the group replaces one function.
  const openChangesReview = (changes, tries = 60) => {
    actions.openSession(changes.sessionId)
    let left = tries
    const timer = setInterval(() => {
      if (mainView() === changes.sessionId) {
        try {
          openReview(changes)
          clearInterval(timer)
          return
        } catch { /* the Session's column is still mounting */ }
      }
      if ((left -= 1) <= 0) {
        clearInterval(timer)
        actions.notice(t('This window cannot open the change review'))
      }
    }, 100)
  }

  const after = promise => promise.then(async (value) => { await pull().catch(() => {}); return value })
  // Sessions owned by an Agent, including ones adopted before the roster caught up.
  const agentSessions = (agentId) => {
    const ids = [...(roster.getSnapshot().agentsById[agentId]?.sessions ?? [])]
    for (const [id, owner] of pendingAdopt) if (owner === agentId && !ids.includes(id)) ids.push(id)
    return ids
  }
  const latestAgentSession = (agentId, list) => agentSessions(agentId)
    .sort((a, b) => (list.byId[b]?.updatedAt ?? 0) - (list.byId[a]?.updatedAt ?? 0))[0]
  const mainView = () => Object.values(ctx.sessions.list.getSnapshot().byId ?? {}).find(session => (session?.retainedBy?.mainView ?? 0) > 0)?.id
  // A Session the Host made a moment ago is not in the shell's list yet, so the main view
  // would keep showing the chat that was there before — for a Bot the user just opened,
  // that reads as "the new Bot loaded someone else's conversation" (#1196). The asked-for
  // Bot stays over that chat until its Session is the one on screen, or the user opens
  // something else. A long wait changes the note and asks for the list again; it does
  // not uncover the previous conversation.
  const ownerOfSession = sessionId => resolveSessionOwner(roster.getSnapshot(), sessionId)
  // Monotonic counter lives inside `nav` (team-core/actions.js).
  const openingWait = bindOpeningWait(ui, {
    onSlow: () => { void Promise.resolve(ctx.sessions.refresh?.()).catch(quietly('refresh sessions')) },
  })
  const beginOpening = (target) => {
    const owner = ownerOfSession(target)
    openingWait.begin({ target, id: owner?.id ?? target, name: owner?.name ?? '' })
  }
  const endOpening = () => { openingWait.end() }
  // A wait that cannot succeed. The roster already knows a Bot lost this Session (the
  // Host marks it when a model selection comes back not-found): keep the cover as a
  // failure card with a way out. Standalone DSH Agent sessions have no cover, so report
  // the failure directly when one never arrives.
  const failOpening = (target, reason = 'missing') => {
    if (ownerOfSession(target) === undefined) {
      endOpening()
      actions.reportError(new Error(t(reason === 'timeout' ? 'This session is not available yet.' : 'This session is no longer available.')), 'open-session')
      return
    }
    openingWait.fail(target, reason)
  }
  const lostSession = (target) => (roster.getSnapshot().bots ?? []).some(bot => bot.sessionMissing === target)
  const show = listedOpener({ list: ctx.sessions.list, refresh: () => Promise.resolve(ctx.sessions.refresh?.()).catch(quietly('refresh sessions')), open: (target) => { expected = target; ctx.uiWorkspace.openSession(target) }, current: mainView, begin: beginOpening, done: endOpening, fail: failOpening, gone: lostSession })
  const nav = createNavigationActions({
    call,
    after,
    pull,
    store,
    onRetry: target => show(target),
    onRecovered: (target) => {
      nav.bumpNavSeq()
      setPlain(false)
      show(target)
    },
    onMissingAfterRecover: () => endOpening(),
    shouldAbortLand: (last) => {
      const now = mainView()
      if (!last || now === undefined || now === last.sessionId) return false
      const snap = roster.getSnapshot()
      const list = ctx.sessions.list.getSnapshot()
      const nowBot = snap.byId[now]
      const nowRoom = snap.roomsById[now]
      return (nowBot !== undefined && currentPart(nowBot) === now)
        || (nowRoom !== undefined && (nowRoom.sessionId ?? nowRoom.id) === now)
        || isAgentSessionId(now)
        || (nowBot === undefined && nowRoom === undefined && list.byId?.[now]?.blank !== true)
    },
    canLandTarget: (target, last) => !(last && target === last.sessionId && ctx.sessions.list.getSnapshot().byId?.[target] === undefined),
    onLand: (target) => {
      setPlain(false)
      show(target)
    },
    reportError: (error, where) => actions.reportError(error, where),
  })
  // Bot mode's view must hold a team conversation; an outside Session wears the
  // Bot skin without one. Runs whenever the surface is (or stays) Bot mode —
  // including a cold start, where no setSurface call ever fires.
  const homeToMainBot = () => {
    const snapshot = roster.getSnapshot()
    if (!snapshot.ready || !snapshot.mainBotId) return
    const main = mainView()
    if (main !== undefined && snapshot.byId[main] === undefined && snapshot.roomsById[main] === undefined) {
      actions.openSession(snapshot.mainBotId)
    }
  }
  const ensureBotHome = () => {
    if (roster.getSnapshot().ready) homeToMainBot()
    else {
      const off = roster.subscribe(() => {
        if (!roster.getSnapshot().ready) return
        off()
        homeToMainBot()
      })
    }
  }
  const actions = {
    ...teamActions({ call, after, partFor, roster, ui, live, cards, heldCards, turnClock, panelFolded, questionDrafts, foldWrites }),
    ...createStoreActions({ store, clearPanelYieldOnToggle: true }),
    ...nav.actions,
    ...updateCtrl.actions,
    ...browserCtrl.actions,
    // The files a group row names open DSH's own review tab for that turn. The tab reads
    // the changes of the Session the shell shows, so that Session is opened first; the same
    // call then retries until its right column is mounted. This jump is the one place a
    // different place for the review (in the group, or a review that carries its Session)
    // would replace. A summary the Host no longer serves, or a window without the column,
    // says so instead of doing nothing.
    openChanges: async (changes) => {
      if (changes === null || typeof changes !== 'object' || typeof changes.sessionId !== 'string'
        || !Number.isInteger(changes.seq) || !Number.isInteger(changes.turn)) return
      let available = false
      try { available = (await call('changes-check', { sessionId: changes.sessionId, seq: changes.seq })) === true } catch { available = false }
      if (!available) { actions.notice(t('These changes are no longer available')); return }
      if (openReview === undefined) { actions.notice(t('This window cannot open the change review')); return }
      openChangesReview(changes)
    },
    // The full-pane overlays sit above the conversation, so opening one must dismiss them
    // or the click appears to do nothing.
    isAgentSession: id => isAgentSessionId(id),
    openSession: (id) => {
      // A DSH Agent Session id lands on the plain surface, not the Bot skin.
      if (isAgentSessionId(id)) return actions.openAgentSession(id)
      nav.bumpNavSeq()
      const target = partFor(id)
      const fromInbox = ui.getSnapshot().inbox === true
      ui.set(state => (state.newChat || state.exchange || state.menu || state.palette || state.groupSearch || state.inbox || state.inboxTarget
        ? { ...state, newChat: null, exchange: null, menu: null, palette: null, groupSearch: null, inbox: false, inboxTarget: fromInbox ? target : null }
        : state))
      setPlain(false)
      show(target)
    },
    // The conversation replacements withdraw for a plain Session; set the surface
    // before the navigation so the Bot skin never flashes.
    openAgentSession: (sessionId) => {
      nav.bumpNavSeq()
      const fromInbox = ui.getSnapshot().inbox === true
      ui.set(state => ({ ...state, newChat: null, exchange: null, menu: null, palette: null, groupSearch: null, inbox: false, inboxTarget: fromInbox ? sessionId : null, details: null, view: 'details', renaming: false, tab: null, task: null, taskDeck: null }))
      setPlain(true)
      show(sessionId)
    },
    addAgent: async () => {
      const agent = await after(call('add-agent'))
      if (agent?.sessions?.[0] !== undefined) actions.openAgentSession(agent.sessions[0])
      return agent
    },
    openAgent: (agentId) => {
      const agent = roster.getSnapshot().agentsById[agentId]
      if (agent === undefined) return
      const list = ctx.sessions.list.getSnapshot()
      const latest = latestAgentSession(agentId, list)
      if (latest === undefined) return actions.newAgentSession(agentId)
      actions.openAgentSession(latest)
    },
    newAgentSession: async (agentId) => {
      const agent = roster.getSnapshot().agentsById[agentId]
      if (agent === undefined) return
      // One create per Agent at a time, so two clicks in a row make one Session.
      return singleFlight(agentNewInFlight, agentId, async () => {
        const list = ctx.sessions.list.getSnapshot()
        const latest = latestAgentSession(agentId, list)
        const pending = pendingAgentSession.get(agentId)
        if (pending !== undefined && list.byId[pending] !== undefined) pendingAgentSession.delete(agentId)
        const reuse = agentSessionToReuse(list, latest, pending)
        if (reuse !== undefined) {
          actions.openAgentSession(reuse)
          return reuse
        }
        const { sessionId } = await after(call('agent-session', { agentId, workspaceId: workspaceOf(latest) }))
        if (ctx.sessions.list.getSnapshot().byId[sessionId] === undefined) pendingAgentSession.set(agentId, sessionId)
        actions.openAgentSession(sessionId)
        return sessionId
      })
    },
    archiveAgentSession: async (agentId, sessionId) => {
      await after(call('agent-archive', { agentId, sessionId }))
      const list = ctx.sessions.list.getSnapshot()
      const main = Object.values(list.byId ?? {}).find(session => (session?.retainedBy?.mainView ?? 0) > 0)?.id
      if (main !== sessionId) return
      const rest = roster.getSnapshot().agentsById[agentId]?.sessions ?? []
      if (rest.length > 0) actions.openAgent(agentId)
      else if (roster.getSnapshot().mainBotId) actions.openSession(roster.getSnapshot().mainBotId)
    },
    renameAgentSession: (agentId, sessionId, title) => after(call('agent-rename', { agentId, sessionId, title })),
    // Removing the Agent archives every Session it owns; one of them may fill the
    // main view, and it must not stay there wearing the Bot surface afterwards.
    removeAgent: async (agentId) => {
      const owned = agentSessions(agentId)
      const result = await after(call('remove-agent', { agentId }))
      const list = ctx.sessions.list.getSnapshot()
      const main = Object.values(list.byId ?? {}).find(session => (session?.retainedBy?.mainView ?? 0) > 0)?.id
      if (main !== undefined && owned.includes(main) && roster.getSnapshot().mainBotId) actions.openSession(roster.getSnapshot().mainBotId)
      return result
    },
    selectPanel: (id) => { ctx.layout.selectPanel(id) },
    toggleSidebar: () => { ctx.layout.toggleSidebar() },
    // Agent mode hands the surface back to the shell; everything open on the Bot
    // surface closes first so nothing stale reopens on the way back.
    setSurface: (mode) => {
      if (mode !== 'bot' && mode !== 'agent') return
      // Already there: still worth the landing check — a cold start never calls
      // setSurface, so this is also how a stuck Bot surface recovers itself.
      if (surface.getSnapshot().mode === mode) {
        if (mode === 'bot') ensureBotHome()
        return
      }
      if (mode === 'agent') {
        ui.set(state => ({ ...state, details: null, view: 'details', task: null, taskDeck: null, settings: null, palette: null, groupSearch: null, newChat: null, inbox: false, menu: null, voice: null, exchange: null, memory: null, toast: null, goalOpen: null, goalCompose: null, approvalOpen: null }))
      }
      writeMode(mode)
      surface.set(state => ({ ...state, mode }))
      // The Bot view kept the shell's sidebar collapsed under its own column; the
      // shell's own view gets it back (below DSH_NARROW the shell decides itself).
      if (mode === 'agent' && window.innerWidth >= DSH_NARROW && frame.getSnapshot().collapsed) ctx.layout.toggleSidebar()
      if (mode !== 'bot') return
      ensureBotHome()
    },
  }
  // Whether AccountLauncher holds the shell's settings seat; FooterAccount steps aside if so.
  actions.signInEntry = () => ctx.slots.entries?.('settings.models.sign-in')?.[0] ?? null
  actions.canSignIn = () => Boolean(actions.signInEntry())
  actions.accountT = () => ctx.get('locale')?.bind?.('settings.account') ?? (key => key)
  // The Voice Input plugin's speech Remote; absent while that plugin is off.
  actions.speech = () => ctx.get('remote.speech') ?? undefined
  // One of DSH's onboarding editors, such as the DeepSeek API key form, opened by id
  // through the settings shell's coordinator.
  actions.openHarnessOnboarding = id => settingsShell?.openOnboarding(id)
  // With the plugin manager mounted, setup is its bundle page (the model's size
  // and download notes live there). Where it is not mounted — the desktop app's
  // profile has no plugin manager — the speech Remote prepares the provider
  // itself, and the voice pane follows its progress.
  actions.voiceSetup = (providerId) => {
    const navigation = ctx.get('pluginNavigation')
    if (navigation !== undefined) return { navigate: () => navigation.openBundle(VOICE_BUNDLE) }
    const speech = ctx.get('remote.speech')
    return speech === undefined || providerId === undefined ? null : { prepare: () => requestPreparation(speech, providerId) }
  }
  // The full text the voice chat reads aloud: the turn's closing Assistant
  // message, not the turn outline's bounded preview. undefined while the chat
  // view has not materialized the turn; null when the Session is not bound.
  actions.closingReply = (sessionId, turn) => {
    try {
      const binding = ctx.sessions.binding(sessionId)
      if (binding === undefined) return null
      return closingReplyText(ctx.uiConversation.binding(binding).target('chat').getSnapshot(), turn)
    } catch {
      return null
    }
  }
  actions.seatAccount = on => ui.set(state => (state.accountSeated === on ? state : { ...state, accountSeated: on }))

  // The desktop app carries the floating indicator and the tray entries, and reads the
  // OS idle time for the foreground gate; the entries and the pushes ride its bridge.
  ctx.effect(() => startComputerBridge({
    call,
    store,
    onStop: (botId, all) => actions.computerStop(botId, all),
    onAllowForeground: botId => actions.computerAllowForeground(botId),
  }), 'ds-bot: computer bridge')
  const face = () => ({ actions, hooks: { roster, ui, activity, work, memoryNews, registry, turnClock, live, computer, cards, heldCards, rescuedDrafts: questionDrafts.rescued, browserPages, browserTabs, browserHolds, botCompletions, surface, update, frame, sidebarPref, settingsShellHeld } })
  // Since DSH 0.2.1-alpha.3 user text is drawn by rules and a content factory, not the
  // primitives' text projection; the user's bubble draws with either (user-message.js).
  const hostDrawsUserText = typeof ctx.uiConversation.userText?.register === 'function'
  // DS Bot's own rows in the `/` menu of a Bot chat and a group chat (the DSH rows stay;
  // the host module stops their execution there).
  ctx.effect(() => installCommandActions(ctx, { roster, actions }), 'ds-bot: bot command actions')
  // Register core DS Bot commands into DSH's shortcut catalog (plugin mode).
  ctx.inject(['shortcuts'], (scope) => {
    scope.effect(() => registerPluginShortcuts(scope.shortcuts, {
      roster,
      ui,
      surface,
      actions,
      mainView,
      sessionsById: () => ctx.sessions.list.getSnapshot().byId,
      onError: (id, error) => {
        noteClientError(`shortcut:${id}`, error)
        console.error(`ds-bot: failed to register shortcut "${id}":`, error)
      },
    }), 'ds-bot: bot shortcuts')
  })
  // DS Bot holds the settings seat in every mode, Agent mode included: the bundle patch
  // turns DSH's own shell off, and this one draws DSH's settings pages in DS Bot's dialog.
  ctx.effect(() => {
    const offStyles = installCompiledStyles(SETTINGS_SHELL_CSS, 'settings-shell')
    settingsShell = installSettingsShell(ctx, { face, actions, ui, held: settingsShellHeld })
    return () => { settingsShell?.dispose(); settingsShell = null; offStyles() }
  }, 'ds-bot: settings shell')
  // The queue dock's per-session verbs, supplied the way the shell's own dock
  // injects them (the session facade and the conversation service).
  const queueFace = (sessionId) => ({
    ...face(),
    updateQueue: async (itemId, action) => (await ctx.sessions.binding(sessionId)?.session?.updateQueue(itemId, action)) ?? { ok: false },
    loadImage: (attachment) => ctx.uiConversation.imageUrl(sessionId, attachment),
  })
  // Move unsubmitted question-card text back to the main composer when a pending
  // question disappears externally (never on explicit submit, skip, scroll, or switch).
  ctx.effect(() => {
    const offRoster = roster.subscribe(() => { questionDrafts.reconcileRoster(roster.getSnapshot()) })
    const offStatus = sessionStatus.source.subscribe(() => { questionDrafts.reconcileBlocking(sessionStatus.source.getSnapshot(), roster.getSnapshot()) })
    return () => { offRoster(); offStatus() }
  }, 'ds-bot: rescue interrupted question drafts')
  ctx.effect(() => noticeApprovals({
    work,
    roster,
    shownSession: shownSessionId,
    openSession: id => actions.openSession(id),
  }), 'ds-bot: approval notifications')
  const assistantFace = (sessionId) => {
    const binding = ctx.sessions.binding(sessionId)
    if (binding === undefined) throw new Error(`ds-bot: unknown session "${sessionId}"`)
    const chat = ctx.uiConversation.binding(binding).target('chat')
    return { ...face(), fileMentions: fileMentionSource(ctx, sessionId), keyedHooks: {
      turnSteps: (turn) => {
        const snapshot = chat.getSnapshot()
        if (snapshot === undefined) throw new Error('ds-bot: Chat target is unavailable')
        return snapshot.nodes.turnDataSource(Number(turn), 'assistant-step')
      },
      turnContext: (turn) => {
        const snapshot = chat.getSnapshot()
        if (snapshot === undefined) throw new Error('ds-bot: Chat target is unavailable')
        return snapshot.nodes.turnDataSource(Number(turn), 'context')
      },
    } }
  }

  // The dock lives outside the chat snapshot, so it subscribes for the turn that
  // owns a card. Until that turn closes, the card stays by the composer.
  actions.turnFacts = (sessionId) => {
    try {
      const binding = ctx.sessions.binding(sessionId)
      if (binding === undefined) return { turns: undefined, openTurn: undefined }
      const conversation = ctx.uiConversation.binding(binding)
      const chat = conversation.target('chat').getSnapshot()
      return { turns: chat?.timeline?.turns, openTurn: conversation.openTurn.getSnapshot() }
    } catch {
      return { turns: undefined, openTurn: undefined }
    }
  }
  actions.watchTurns = (sessionId, listener) => {
    try {
      const binding = ctx.sessions.binding(sessionId)
      if (binding === undefined) return () => {}
      const conversation = ctx.uiConversation.binding(binding)
      const offChat = conversation.target('chat').subscribe(listener)
      const offOpen = conversation.openTurn.subscribe(listener)
      return () => { offChat(); offOpen() }
    } catch {
      return () => {}
    }
  }
  // Enter on an empty composer while the Bot works sends the user's queued
  // messages into the running turn (the "+" owns the key; #839).
  actions.steerQueued = async (sessionId) => {
    const session = ctx.sessions.binding(sessionId)?.session
    if (session === undefined) return
    const steerBatch = roster.getSnapshot().byId?.[sessionId] !== undefined
      ? async (ids) => {
          try {
            const result = await actions.steerQueueBatch(sessionId, ids)
            return result?.fallback === true ? 'fallback' : 'done'
          } catch (error) {
            return error?.code === 'bot/not-found' ? 'fallback' : 'failed'
          }
        }
      : undefined
    if (await steerQueued(session, steerBatch) === 'failed') {
      actions.reportError(new Error(t('Couldn’t steer the queued messages. Try again.')), 'steer-queue')
    }
  }
  // The shell's own draft intake, for files a chat's draft gets back (draft-keep.js).
  actions.draftFiles = (ids) => {
    const conversation = ctx.get('conversation')
    if (ids.length === 0 || typeof conversation?.resolveDraftAttachments !== 'function') return []
    return conversation.resolveDraftAttachments(ids).map(item => ({ kind: item.kind, file: item.file }))
  }
  actions.restoreDraftFiles = (sessionId, files) => {
    const conversation = ctx.get('conversation')
    if (typeof conversation?.createDrafts !== 'function') return []
    return conversation.createDrafts(sessionId, files, true).map(item => item.id)
  }
  actions.releaseDraftFiles = (ids) => {
    const conversation = ctx.get('conversation')
    if (typeof conversation?.releaseDraftAttachment !== 'function') return
    for (const id of ids) conversation.releaseDraftAttachment(id)
  }
  // A terminal tab in DSH's right column, only where the terminal plugin
  // registered its type and the column face is there.
  actions.canOpenTerminal = () => ctx.get('sidebarRight') !== undefined && ctx.get('sidebarRightTabs')?.get('terminal') !== undefined
  // The tabs of the terminals a shown Bot starts, as DSH's own header opens them.
  actions.watchAgentTerminals = sessionId => watchAgentTerminals(ctx.slots, sessionId, error => actions.reportError(error, 'right-sidebar'))
  actions.newTerminal = () => {
    // The column takes the drawer's space: hand it over first.
    actions.closePanel()
    try {
      callServiceMethod(ctx, 'sidebarRight', 'openTab', 'terminal')
    } catch (error) {
      actions.reportError(error, 'right-sidebar')
    }
  }
  // The same hand-off for DSH's files tab, where that plugin registered it.
  actions.canOpenFiles = () => ctx.get('sidebarRight') !== undefined && ctx.get('sidebarRightTabs')?.get('files') !== undefined
  actions.openFiles = () => {
    actions.closePanel()
    try {
      callServiceMethod(ctx, 'sidebarRight', 'openTab', 'files')
    } catch (error) {
      actions.reportError(error, 'right-sidebar')
    }
  }

  // The drawer and DSH's right column never share the window: whichever the
  // user asked for last wins. The column's state is read off the frame's
  // attributes through a MutationObserver. `mounted` moves before the DOM of a
  // Session switch does, so a switch opens a timed window (createSwitchWindow):
  // an attribute batch inside it is the switch revealing that Session's own
  // column — the drawer wins and folds it back — while one outside it is the
  // user's own opening and takes the space.
  ctx.inject(['sidebarRight'], (scope) => {
    scope.effect(() => {
      let open = rightColumnOpen(document)
      // Long enough for a fullscreen panel's slide, which reports only once it ends.
      const switchWindow = createSwitchWindow(done => setTimeout(done, 400))
      const collapseColumn = () => {
        try {
          if (callServiceMethod(scope, 'sidebarRight', 'isExpanded')) callServiceMethod(scope, 'sidebarRight', 'toggleExpanded')
        } catch (error) {
          actions.reportError(error, 'right-sidebar')
        }
      }
      const observer = new MutationObserver(() => {
        const next = rightColumnOpen(document)
        const opening = next && !open
        open = next
        const verdict = opening ? columnOpened(ui.getSnapshot().details !== null, switchWindow.pending) : null
        if (verdict === 'close-drawer') actions.closePanel()
        else if (verdict === 'collapse-column') collapseColumn()
      })
      observer.observe(document.documentElement, {
        subtree: true, attributes: true, attributeFilter: RIGHTBAR_ATTRIBUTES,
      })
      let offDirectMounted = null
      const releaseDirectMounted = () => {
        const off = offDirectMounted
        offDirectMounted = null
        off?.()
      }
      const mountedFiber = scope.inject(['sidebarRight.mounted'], (mountedScope) => {
        mountedScope.effect(() => {
          releaseDirectMounted()
          const off = mountedScope['sidebarRight.mounted']?.subscribe?.(() => switchWindow.moved())
          return () => { off?.() }
        }, 'ds-bot: sidebarRight.mounted')
      })
      if (!hasContextProperty(scope, 'sidebarRight.mounted')) {
        offDirectMounted = scope.sidebarRight?.mounted?.subscribe?.(() => switchWindow.moved()) ?? null
      }
      let drawer = ui.getSnapshot().details !== null
      const offUi = ui.subscribe(() => {
        const next = ui.getSnapshot().details !== null
        if (next && !drawer && drawerOpened(rightColumnOpen(document)) === 'collapse-column') collapseColumn()
        drawer = next
      })
      return () => { observer.disconnect(); releaseDirectMounted(); mountedFiber.dispose(); offUi() }
    }, 'ds-bot: one right panel')
  })

  // A Bot surface owns the cells it shadows. It starts far below the -10 that plugins
  // commonly use and goes below whatever already holds the cell, so a plugin that
  // shadows the same cell neither breaks the install nor shows through.
  const BOT_PRIORITY = -100
  const shadow = (name, options, component) => ctx.slots.inject(name, () => ctx.slots.register({
    name, ...options, ...(options.priority === undefined ? {} : { priority: freePriority(ctx.slots.entries(name), options) }),
  }, component))
  const installHeader = () => ctx.slots.inject('conversation.session.header', () => installHeaderNavigation(ctx.slots, () => ({ ...face(), PendingLearning }), HeaderPill, BOT_PRIORITY))

  // The "@" menu's Bot group and the chats "+" references. The composer's controller
  // for a Session is the shell's own, so the chats open at its caret.
  let atMenu = null
  const installAtMenu = () => {
    const fiber = ctx.inject(['inputTriggers'], (scope) => {
      scope.effect(() => {
        const triggers = scope.inputTriggers
        const controllerOf = (sessionId) => {
          const binding = ctx.sessions.binding(sessionId)
          return binding === undefined ? undefined : triggers.sessionOf(binding.ctx)
        }
        const launched = sessionId => controllerOf(sessionId)?.launcher.getSnapshot() === CHATS_SOURCE
        const offs = [
          ...atSources({ roster, sessions: ctx.sessions, launched, iconFor: menuIcons(roster) }).map(source => triggers.registerSource(source)),
          triggers.registerSource(sideSource({ roster, actions })),
        ]
        atMenu = { controllerOf }
        return () => {
          atMenu = null
          for (const off of offs) off()
        }
      }, 'ds-bot: @ menu')
    })
    return () => fiber.dispose()
  }
  actions.canReferenceChat = () => atMenu !== null
  actions.referenceChat = (sessionId, span) => {
    const controller = atMenu?.controllerOf(sessionId)
    if (controller === undefined || span === undefined) return
    controller.toggleSource(CHATS_SOURCE, { trigger: '@', query: '', quoted: false, position: 'inline', span })
  }

  // The panel's yield flag and the drawer's flag follow the frame: opening (or
  // re-aiming) a panel that does not fit yields the column to the rail; a panel
  // that fits again, or is closed, and a drawer that no longer applies drop
  // their flags.
  const installFrameSync = () => {
    let lastDetails = ui.getSnapshot().details
    const sync = () => {
      const s = ui.getSnapshot()
      const f = frame.getSnapshot()
      // Only a fresh open counts: a folded panel that just follows the chat to
      // another subject is not the user asking to see it — the openers in
      // team-actions carry the yield themselves.
      const opened = s.details !== null && lastDetails === null
      lastDetails = s.details
      const layout = frameLayout({ viewport: f.viewport, sidebarWidth: f.sidebarWidth, pref: sidebarPref.getSnapshot(), drawer: s.leftDrawer === true, panel: s.details === null ? null : { view: s.view, yielded: false } })
      if (s.details === null) {
        if (s.panelYield) actions.setPanelYield(false)
      } else if (!s.panelYield && opened && layout.panel === 'folded') actions.setPanelYield(true)
      else if (s.panelYield && layout.panel === 'shown') actions.setPanelYield(false)
      if (s.leftDrawer === true && layout.left !== 'drawer') actions.setLeftDrawer(false)
    }
    const offs = [ui.subscribe(sync), frame.subscribe(sync), sidebarPref.subscribe(sync)]
    return () => { for (const off of offs) off() }
  }

  // The shell group paints the team surface around the session; the conversation
  // group re-skins the session itself. Each step returns a disposer from slots.inject,
  // so a surface change withdraws the whole group and the outlets re-render.
  // The shell group's sheets. Strip and panel styles also serve the side-chat tabs, which need no bridge.
  const SHELL_SHEETS = [
    [SHELL_CSS, 'shell'],
    [DSH_SHELL_CSS, 'dsh-shell'],
    [SIDEBAR_CSS, 'sidebar'],
    [INBOX_CSS, 'inbox'],
    [SECRET_CSS + CONNECTOR_CSS + CONNECTORS_PAGE_CSS + PROVIDERS_CSS, 'secrets'],
    [LEARNING_CSS, 'learning'],
    [AGENT_PRESET_CSS, 'agent-presets'],
    [MODEL_CSS + FOLDER_CSS + BOT_SETTINGS_CSS + BOT_MODELS_CSS + AGENT_CARDS_CSS + GROUP_SETTINGS_CSS + AVATAR_LIBRARY_CSS, 'models'],
    [USAGE_CSS, 'usage'],
    [SCHEDULE_CSS, 'schedules'],
    [APPEARANCE_PAGE_CSS, 'appearance-page'],
    [SHORTCUTS_PAGE_CSS, 'shortcuts-page'],
    [FEEDBACK_CSS, 'feedback'],
    [PRIVACY_CSS, 'privacy'],
    [ABOUT_CSS, 'about'],
    [MEMBER_CSS, 'members'],
    [TASK_CSS, 'tasks'],
    [PASTE_CSS + DSH_PASTE_CSS, 'paste'],
    [OPENING_CSS, 'opening'],
    [IM_CSS, 'im'],
    [GOAL_CSS, 'goal'],
    [TASKS_CSS, 'tasks'],
    [USER_MESSAGE_CSS, 'user-messages'],
    [WIDGET_CSS, 'widgets'],
    [CHANGES_CSS, 'changes'],
    [HANDOFF_CSS, 'handoff'],
    [SIDE_CSS, 'side'],
    [BROWSER_CSS, 'browser'],
  ]
  // Settings outside Bot mode (Agent mode) brings DS Bot's own rules and colors while it
  // shows; the shell overrides and DSH's tokens stay as Agent mode has them.
  let shellSheets = 0
  actions.holdSettingsLook = () => {
    if (shellSheets > 0) return () => {}
    const syncEffects = () => {
      const current = roster.getSnapshot()
      document.body.dataset.btEffects = effectsOf(current.ready ? current.prefs ?? {} : savedPrefs)
      if (WINDOWS) document.body.dataset.btOs = 'windows'
    }
    syncEffects()
    const snapshot = roster.getSnapshot()
    const prefs = snapshot.ready ? snapshot.prefs ?? {} : savedPrefs
    const themes = themesOf(prefs)
    const theme = themes[prefs.theme] ?? themes.deepseek
    const offs = [
      roster.subscribe(syncEffects),
      ...SHELL_SHEETS.map(([text, tag]) => installCompiledStyles(botOwnCss(text), `settings-${tag}`)),
      installCompiledStyles(botOwnCss(themeCss(theme, isHex(prefs.accent) ? prefs.accent : undefined)), 'settings-theme'),
    ]
    return () => {
      delete document.body.dataset.btEffects
      delete document.body.dataset.btOs
      for (const off of offs) off()
    }
  }
  const installShell = () => [
    () => { shellSheets += 1; return () => { shellSheets -= 1 } },
    ...SHELL_SHEETS.map(([text, tag]) => () => installCompiledStyles(text, tag)),
    () => installDshAdapter(document),
    () => installFrameWatch(frame),
    () => installFrameSync(),
    () => installTheme(),
    () => shadow('sidebar.workspaces', { priority: BOT_PRIORITY, inject: () => ({ actions, hooks: { ...face().hooks, botCompletions } }) }, TeamSidebar),
    () => shadow('sidebar.brand.mark', { priority: BOT_PRIORITY }, BrandMark),
    () => shadow('sidebar.brand.name', { priority: BOT_PRIORITY }, BrandName),
    () => shadow('sidebar.footer.action', { id: 'bot-account', order: -200, inject: face }, FooterAccount),
    () => shadow('settings.trigger', { priority: BOT_PRIORITY }, YouAvatar),
    // The whale wins the seat over a shell account plugin's own launcher (the
    // Desktop's "··· More"), which comes back in Agent mode.
    () => shadow('settings.launcher', { priority: BOT_PRIORITY, inject: face }, AccountLauncher),
    () => shadow('shell.overlay', { id: 'bot-computer', order: 40, inject: face }, ComputerIndicator),
    () => shadow('shell.overlay', { id: 'bot', order: 50, inject: face }, Overlays),
    () => shadow('shell.overlay', { id: 'bot-signin', order: 55, inject: face }, DeepSeekSignIn),
    () => shadow('shell.overlay', { id: 'bot-toast', order: 60, inject: face }, ErrorToast),
  ]
  const installConversation = () => [
    () => installCompiledStyles(CONVERSATION_CSS, 'conversation'),
    () => installCompiledStyles(DSH_CONVERSATION_CSS, 'dsh-conversation'),
    () => installCompiledStyles(TURN_ERROR_CSS, 'turn-errors'),
    () => installCompiledStyles(QUEUE_CSS, 'queue'),
    () => installCompiledStyles(ANNOTATION_CSS, 'text-annotation'),
    () => installMentions(),
    () => installAtMenu(),
    installHeader,
    () => shadow('conversation.chat.text-interaction', { key: 'quote', priority: BOT_PRIORITY, locale: 'messageQuotes', inject: face }, TextSelectionAction),
    () => shadow('conversation.chat.node', { key: 'assistant-step', priority: BOT_PRIORITY, locale: 'chat', inject: assistantFace }, AssistantCell),
    () => shadow('conversation.chat.node', { key: 'turn-trigger', priority: BOT_PRIORITY, locale: 'chat', inject: face }, TriggerCell),
    () => shadow('conversation.chat.node', { key: 'tool-call', priority: BOT_PRIORITY, locale: 'chat', inject: face }, ToolCell),
    () => shadow('conversation.chat.node', { key: 'turn-process', priority: BOT_PRIORITY, locale: 'chat', inject: face }, TurnProcessCell),
    // A failed turn shows what the user can do about it instead of the provider's raw text.
    () => shadow('conversation.chat.node', { key: 'turn-error', priority: BOT_PRIORITY, locale: 'chat', inject: face }, FailureCell),
    // DSH's own turn tail stays, so what other plugins add there shows, such as the
    // cards of the files a turn delivered; its copy and branch row is hidden.
    () => shadow('conversation.chat.turnTail', { id: 'bot-turn-separators', order: 1000, inject: face }, TurnTailCell),
    // A side question is not a transcript row. After its snapshot turn closes it
    // sits on that turn's tail, ahead of the time separator.
    () => shadow('conversation.chat.turnTail', { id: 'bot-btw', order: 800, priority: BOT_PRIORITY, inject: face }, BtwTurnTail),
    () => shadow('conversation.chat.turnTail', { id: 'bot-learning', order: 850, priority: BOT_PRIORITY, inject: face }, LearningTurnTail),
    // The cards of the files a turn delivered get a Save action beside DSH's own
    // actions, so a phone browser can put the file on the device.
    () => ctx.slots.inject('deliverables.file.actions', () => ctx.slots.register({ name: 'deliverables.file.actions', id: 'bot-file-save', locale: 'chat' }, SaveFileAction)),
    // A Bot condenses its conversation without telling anyone; the chat keeps showing
    // every message.
    () => shadow('conversation.chat.node', { key: 'question-reply', priority: BOT_PRIORITY, locale: 'chat' }, AnsweredReply),
    () => shadow('conversation.chat.node', { key: 'compaction', priority: BOT_PRIORITY, locale: 'chat' }, CellEmpty),
    // A Bot chat leaves DSH's context lines (tool updates, injected context) out; a Bot
    // message spliced in mid-turn gets an event line from the step that reads it instead.
    () => shadow('conversation.chat.node', { key: 'context', priority: BOT_PRIORITY, locale: 'chat' }, CellEmpty),
    ...(canDrawUserMessages(hostDrawsUserText) ? [() => installUserBubble(ctx.slots, () => {
      const offs = ['user', 'steering'].map(key => shadow('conversation.chat.node', { key, priority: BOT_PRIORITY, locale: 'chat', inject: face }, UserMessageCell))
      return () => { for (const off of offs) off() }
    })] : []),
    // DSH 0.2.2-rc.1 draws user text by rules, and its file rule cuts "@新 Bot" at the
    // space. A rule of ours claims a whole Bot name first; releases that still have the
    // text projection (above) have no such registry.
    ...(typeof ctx.uiConversation.userText?.register === 'function' ? [
      () => installBotMentionRule(ctx.uiConversation.userText, roster),
      () => shadow('conversation.user.text.node', { key: BOT_MENTION_ID, inject: face }, BotMention),
    ] : []),
    () => shadow('conversation.input.permission', { priority: BOT_PRIORITY }, Nothing),
    () => shadow('conversation.input.plan', { priority: BOT_PRIORITY }, Nothing),
    // The composer carries no model picker or run statistics; a Bot's model lives
    // in its details panel.
    () => shadow('conversation.input.model', { priority: BOT_PRIORITY }, Nothing),
    () => shadow('conversation.composer.dock', { id: 'activity', order: 0, priority: BOT_PRIORITY }, Nothing),
    () => shadow('conversation.composer.dock', { id: 'usage', order: 1, priority: BOT_PRIORITY }, Nothing),
    () => shadow('conversation.composer.dock', { id: 'btw', order: 2, priority: BOT_PRIORITY, inject: face }, BtwDock),
    () => shadow('conversation.input.left', { id: 'bot-draft', order: -120, inject: face }, DraftKeeper),
    () => shadow('conversation.input.left', { id: 'bot-paste', order: -110, inject: face }, PasteGuard),
    () => shadow('conversation.input.left', { id: 'bot-plus', order: -100, inject: face }, ComposerPlus),
    () => shadow('conversation.input.right', { id: 'bot-voice', order: 100, inject: face }, ComposerVoice),
    () => shadow('conversation.composer', {
      priority: BOT_PRIORITY,
      inject: face,
      select: owner => (owner.pendingInteraction?.kind === 'question' ? owner.pendingInteraction : null),
    }, QuestionCard),
    () => shadow('conversation.input.dock', { id: 'bot-paste', order: -130, inject: face }, PasteDock),
    () => shadow('conversation.input.dock', { id: 'bot-members', order: -120, inject: face }, MemberDock),
    () => shadow('conversation.input.dock', { id: 'bot-model', order: -110, inject: face }, ModelChoiceDock),
    () => shadow('conversation.input.dock', { id: 'bot-question', order: -100, inject: face }, QuestionDock),
    () => shadow('conversation.input.dock', { id: 'bot-view', order: -95, inject: face }, WidgetDock),
    () => shadow('conversation.input.dock', { id: 'bot-secret', order: -90, inject: face }, SecretDock),
    () => shadow('conversation.input.dock', { id: 'bot-connector', order: -89, inject: face }, ConnectorDock),
    () => shadow('conversation.input.dock', { id: 'bot-mail', order: -88, inject: face }, MailDock),
    () => shadow('conversation.input.dock', { id: 'bot-work-pause', order: -86, inject: face }, WorkPauseDock),
    () => shadow('conversation.input.dock', { id: 'bot-handoff', order: -85, inject: face }, HandoffDock),
    () => shadow('conversation.input.dock', { id: 'bot-computer-handoff', order: -84, inject: face }, ComputerHandoffDock),
    () => shadow('conversation.input.dock', { id: 'bot-computer-app', order: -83, inject: face }, AppAccessDock),
    () => shadow('conversation.input.dock', { id: 'bot-learning', order: 850, priority: BOT_PRIORITY, inject: face }, LearningDock),
    // The shell's own queue dock lists every queued inbox row as the user's
    // drafts — including the team's relayed mail. Reusing its id puts ours in
    // its cell; it lists only the sends the user authored (#663).
    () => shadow('conversation.input.dock', { id: 'queue', order: 20, priority: BOT_PRIORITY, inject: queueFace }, QueueDock),
  ]
  // The return button belongs to neither group: it renders only in Agent mode.
  ctx.effect(() => installCompiledStyles(RETURN_TOKENS + RETURN_CSS, 'return'), 'ds-bot: return styles')
  ctx.effect(() => installCompiledStyles(COMPUTER_CSS, 'computer'), 'ds-bot: computer styles')
  shadow('sidebar.footer.action', { id: 'bot-return', order: -300, inject: face }, BotReturn)

  ctx.effect(() => {
    let stopped = false
    let timer = 0
    let forks = null
    const syncTimer = () => {
      if (stopped) return
      const active = forks?.hasPending() === true
      if (active && !timer) timer = setInterval(reconcile, 5000)
      else if (!active && timer) { clearInterval(timer); timer = 0 }
    }
    const reconcile = () => {
      if (stopped || !forks) return
      void forks.reconcile()
        .catch(error => actions.reportError(error, 'agent-fork-reconcile'))
        .finally(syncTimer)
    }
    forks = installAgentForks({
      sessions: ctx.sessions,
      ownerOf: id => roster.getSnapshot().agentOf[id],
      hasAgent: id => roster.getSnapshot().agentsById[id] !== undefined,
      pending: pendingAdopt,
      ready: async () => { if (!roster.getSnapshot().ready) await pull() },
      adopt: (agentId, sessionId) => call('agent-adopt', { agentId, sessionId }),
      refresh: pull,
      report: (error, source) => actions.reportError(error, source),
      storage: globalThis.localStorage,
      onPendingChange: syncTimer,
    })
    const onChange = () => {
      if (stopped) return
      if (forks.hasPending()) reconcile()
      else syncTimer()
    }
    const onStorage = (event) => {
      if (!stopped && (event.key === null || event.key === STORAGE.agentForks)) reconcile()
    }
    const offRoster = roster.subscribe(onChange)
    const offList = ctx.sessions.list.subscribe(onChange)
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('storage', onStorage)
    }
    reconcile()
    return () => {
      stopped = true
      offRoster()
      offList()
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('storage', onStorage)
      }
      if (timer) { clearInterval(timer); timer = 0 }
      return forks.dispose()
    }
  }, 'ds-bot: Agent forks')

  // The main view decides `plain`: a DSH Agent Session keeps the Bot shell but
  // withdraws the conversation replacements, so the native dsh page shows. The
  // hero's workspace picker creates a blank Session, adopted into the same Agent;
  // forks are captured at creation above, without depending on list metadata.
  ctx.effect(() => {
    let previous
    const sync = () => {
      const list = ctx.sessions.list.getSnapshot()
      const main = Object.values(list.byId ?? {}).find(session => (session?.retainedBy?.mainView ?? 0) > 0)?.id
      const plain = isAgentSessionId(main)
      setPlain(plain)
      if (plain) dropPanels()
      if (main === previous) return
      const before = previous
      previous = main
      const ours = expected !== null && main === expected
      expected = null
      if (ours || main === undefined) return
      // Adoption is a Bot-mode affair: in Agent mode the native sidebar owns
      // navigation, and opening an existing Session there must not pull it in.
      if (surface.getSnapshot().mode !== 'bot') return
      const agentId = before !== undefined ? agentOfSession(before) : undefined
      if (agentId === undefined) return
      const snapshot = roster.getSnapshot()
      if (snapshot.byId[main] !== undefined || snapshot.roomsById[main] !== undefined || agentOfSession(main) !== undefined) return
      // Only a blank Session from the workspace picker joins here. Existing
      // Sessions opened from the native sidebar keep their tools and stay out.
      const row = list.byId[main]
      // A subagent child reports the Agent Session as its parent, but adopting it
      // would steal it from subagent routing — the Host refuses anyway, so skip.
      if (row?.origin === 'subagent') return
      if (row?.blank !== true) return
      pendingAdopt.set(main, agentId)
      setPlain(true)
      void call('agent-adopt', { agentId, sessionId: main }).then(() => pull()).catch((error) => {
        pendingAdopt.delete(main)
        console.warn('[ds-bot] agent-adopt', error)
        // The Session never joined the Agent: the sync puts the team surface
        // back (a Map delete fires no subscription), and the user hears why.
        sync()
        actions.reportError(error, 'agent-adopt')
      })
      // The hero's workspace picker leaves the blank Session it switched away from
      // behind; in another workspace it stays empty forever, so it is archived.
      const next = workspaceOf(main)
      if (list.byId[before]?.blank === true && next !== undefined && workspaceOf(before) !== next) {
        void call('agent-archive', { agentId, sessionId: before }).then(() => pull()).catch(() => {})
      }
    }
    const offList = ctx.sessions.list.subscribe(sync)
    const offRoster = roster.subscribe(sync)
    sync()
    return () => { offList(); offRoster() }
  }, 'ds-bot: agent surface')

  ctx.effect(() => watchBotCompletions({
    roster, sessions: ctx.sessions.list, statuses: sessionStatus.source, unread: botCompletions, ui,
  }), 'ds-bot: sidebar completions')

  ctx.effect(() => {
    const groups = surfaceGroups({ shell: installShell, conversation: installConversation }, {
      onError: (_group, error) => actions.reportError(new Error(t('Bot mode could not be set up here: {error}', { error: error?.message ?? String(error) })), 'surface'),
    })
    // A shadow step can mount "successfully" with nothing registered: when a
    // slot's inject callback throws inside the host, the host cancels the
    // declaration's subscription but the step's disposer still counts the group
    // as mounted. After the shell goes on, check that its sidebar entry really
    // landed; remount a few times when it did not (cold start race).
    let verifyTimer = 0
    let verifyAttempts = 0
    const verifySidebar = () => {
      if (!groupsFor(surface.getSnapshot()).shell) return
      let landed = false
      let declared = true
      try {
        landed = ctx.slots.entries('sidebar.workspaces').some(entry => entry.component === TeamSidebar)
        declared = ctx.slots.spec?.('sidebar.workspaces') !== undefined
      } catch {
        declared = false
      }
      if (landed) return
      if (!declared) {
        // The slot itself is not declared yet; keep watching for a while.
        if (verifyAttempts < 20) {
          verifyAttempts += 1
          verifyTimer = setTimeout(verifySidebar, 250)
        }
        return
      }
      if (verifyAttempts >= 3) return
      verifyAttempts += 1
      console.warn('[ds-bot] sidebar entry missing after shell mount; remounting')
      groups.remount('shell')
      verifyTimer = setTimeout(verifySidebar, 250)
    }
    const reconcile = () => {
      groups.reconcile(groupsFor(surface.getSnapshot()))
      clearTimeout(verifyTimer)
      verifyAttempts = 0
      verifyTimer = setTimeout(verifySidebar, 250)
    }
    reconcile()
    if (surface.getSnapshot().mode === 'bot') ensureBotHome()
    const unsub = surface.subscribe(reconcile)
    return () => {
      unsub()
      clearTimeout(verifyTimer)
      groups.dispose()
    }
  }, 'ds-bot: surface')
}
