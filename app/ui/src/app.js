import { Component, createElement as h, Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { maskOf } from '../../../ds-bot/src/client/characters.js'
import { sendsOnEnter } from '../../../ds-bot/src/client/enter-key.js'
import { ErrorToast } from '../../../ds-bot/src/client/feedback.js'
import { ConnectionIslandPod, HeaderPill } from '../../../ds-bot/src/client/header.js'
import { DynamicIsland } from '../../../ds-bot/src/client/ui/island.js'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { SidebarIcon } from '../../../ds-bot/src/client/icons.js'
import { inkText, paintCss } from '../../../ds-bot/src/client/inks.js'
import { PendingLearning } from '../../../ds-bot/src/client/learning-card.js'
import { lookOf } from '../../../ds-bot/src/client/mark.js'
import { DeepSeekSignIn } from '../../../ds-bot/src/client/model-menu.js'
import { Overlays } from '../../../ds-bot/src/client/overlays.js'
import { ReloadConfirmHost } from '../../../ds-bot/src/client/reload-recovery.js'
import { ESCAPE_PRIORITY, useEscape } from '../../../ds-bot/src/client/overlay-hooks.js'
import { BotReturn, TeamSidebar, YouAvatar } from '../../../ds-bot/src/client/sidebar.js'
import { installStyles } from '../../../ds-bot/src/client/styles.js'
import { MENTION_ORIGIN } from '../../../ds-bot/src/client/text.js'
import { allThemes, effectsOf, flatWidthOf, layoutOf, themeCss, themesOf, widthOf } from '../../../ds-bot/src/client/themes.js'
import { appearanceCss, onSafeAppearance, pictureUrl, safeAppearance, watchSafeAppearance } from '../../../ds-bot/src/client/appearance.js'
import { call } from '../../../ds-bot/src/client/api.js'
import { readAppearance } from '../../../ds-bot/src/shared/appearance.js'
import { paintMode } from './mode.js'
import { Chat } from './chat.js'
import { AgentEmptyHero, ClassicHeader, ClassicSidebar } from './classic-sidebar.js'
import { useDshSettingsBridge } from './engine-settings-bridge.js'
import { getAppLocale } from './locale.js'
import { pluginRuntime, usePluginPage } from './plugin-runtime.js'
import { WorkspacePaneBody, buildWorkspaceTabs } from './right-panel.js'
import { ShortcutsDialog, matchGlobalShortcut, resolveActiveModal, setLiveShortcutContext } from './shortcuts.js'
import { SHORTCUT_BY_ID, isCommandAvailable, isShortcutRecording, shortcutsStore, visibleClassicSessions, visibleSidebarTargets } from '../../../ds-bot/src/client/shortcuts-model.js'
import { RIGHT_PANE_TAB_SLOT, ShellOverlayHost, slots, useSlotEntries } from './slots.js'
export { ShellOverlayHost }
import { createTeam } from './team.js'
import { conversationTitleOf, useWindowTitle } from './window-title.js'

const CLASSIC_BROWSER_OWNER = 'classic'

// The team's theme, accent and appearance. The window owns fonts, sizes, window material
// and light or dark here; in DSH those are DSH's settings (docs/plans/2026-11-21-appearance.md).
function useTheme(prefs, chat, actions, registryVersion) {
  const [loaded, setLoaded] = useState(0)
  const [safe, setSafe] = useState(safeAppearance)
  useEffect(() => onSafeAppearance((on) => {
    setSafe(on)
    if (on) actions.notice?.(t('Safe appearance: the background and your stylesheet are off in this window. Turn them back on in Settings → Appearance.'))
  }), [])
  useEffect(() => watchSafeAppearance(), [])
  useEffect(() => {
    const appearance = readAppearance(prefs?.appearance)
    const theme = themesOf(prefs)[prefs?.theme] ?? allThemes().deepseek
    const style = document.createElement('style')
    style.textContent = themeCss(theme, prefs?.accent) + '\n' + appearanceCss({
      appearance: prefs?.appearance, theme, background: chat?.background, fonts: true, safe,
      pictureUrl: id => pictureUrl(id, call, () => setLoaded(count => count + 1)),
    })
    document.head.append(style)
    const effectiveBackground = safe ? undefined : (chat?.background ?? appearance.background)
    document.body.dataset.btMaterial = (appearance.material === false || Boolean(effectiveBackground)) ? 'off' : 'on'
    if (prefs?.motion) document.body.dataset.btMotion = prefs.motion
    else delete document.body.dataset.btMotion
    document.body.dataset.btEffects = effectsOf(prefs)
    document.body.dataset.btLayout = layoutOf(prefs)
    if (typeof navigator !== 'undefined') {
      const osAgent = navigator.platform || navigator.userAgent || ''
      if (/\bwin/iu.test(osAgent)) document.body.dataset.btOs = 'windows'
      else if (/\bmac/iu.test(osAgent)) document.body.dataset.btOs = 'macos'
    }
    document.body.style.setProperty('--bt-msg-w', String(widthOf(prefs) / 100))
    document.body.style.setProperty('--bt-flat-w', String(flatWidthOf(prefs) / 100))
    return () => {
      delete document.body.dataset.btMaterial
      delete document.body.dataset.btEffects
      delete document.body.dataset.btLayout
      document.body.style.removeProperty('--bt-msg-w')
      document.body.style.removeProperty('--bt-flat-w')
      style.remove()
    }
  }, [prefs, chat?.background, safe, loaded, registryVersion])
  const mode = readAppearance(prefs?.appearance).mode
  useEffect(() => paintMode(mode), [mode])
}

// Bot mentions in rendered replies (`.bt-bubble a[href="https://bot.mention.invalid/<id>"]`)
// wear each Bot's accent color and silhouette/avatar mark, matching plugin mode without DSH selectors.
// Reuses one `<style>` element and skips DOM writes when no Bot look changed.
function useMentions(bots, registryVersion) {
  const styleRef = useRef(null)
  const lastSigRef = useRef(null)
  const lastCssRef = useRef('')

  useEffect(() => {
    if (typeof document === 'undefined' || !document.head) return undefined
    const style = installStyles('', 'mentions')
    styleRef.current = style
    lastSigRef.current = null
    lastCssRef.current = ''
    return () => {
      style.remove()
      if (styleRef.current === style) styleRef.current = null
      lastSigRef.current = null
      lastCssRef.current = ''
    }
  }, [])

  useEffect(() => {
    const style = styleRef.current
    if (!style) return
    const list = Array.isArray(bots) ? bots : []
    const sig = `${registryVersion}|${list.map(b => `${b?.id ?? ''}:${b?.color ?? ''}:${b?.avatar?.shape ?? ''}:${b?.avatar?.color ?? ''}:${b?.avatar?.image ?? ''}`).join(';')}`
    if (sig === lastSigRef.current) return
    lastSigRef.current = sig
    const css = list.map((bot) => {
      if (!bot?.id) return ''
      const anchor = `.bt-bubble a[href="${MENTION_ORIGIN}${bot.id}"]`
      const look = lookOf(bot)
      const mark = look.image
        ? `${anchor}::before{background:center/cover url("${look.image}");-webkit-mask:none;mask:none;border-radius:50%}`
        : `${anchor}::before{background:${paintCss(look.color)};-webkit-mask-image:${maskOf(look.shape)};mask-image:${maskOf(look.shape)}}`
      return `${anchor}{color:${inkText(look.color)}}${mark}`
    }).filter(Boolean).join('\n')
    if (css !== lastCssRef.current) {
      style.textContent = css
      lastCssRef.current = css
    }
  }, [bots, registryVersion])
}

// A dialog or panel that fails closes, and the failure shows as a toast; the window stays.
// One that fails again at once stays closed.
class Contain extends Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
    this.failedAt = 0
  }

  static getDerivedStateFromError() { return { failed: true } }

  componentDidCatch(error) {
    this.props.onError(error)
    if (Date.now() - this.failedAt > 1000) this.setState({ failed: false })
    this.failedAt = Date.now()
  }

  render() { return this.state.failed ? null : this.props.children }
}

function makeTeamUiHook(useUi, isNarrow, drawerOpen) {
  let lastState = null
  let lastPatched = null
  return function useTeamUi(selector) {
    return useUi((state) => {
      if (!isNarrow || state.leftDrawer === drawerOpen) return selector(state)
      if (state !== lastState) {
        lastState = state
        lastPatched = { ...state, leftDrawer: drawerOpen }
      }
      return selector(lastPatched)
    })
  }
}

function ClassicTitleToggle({ hidden, onToggle }) {
  if (typeof document === 'undefined') return null
  const titlebar = document.documentElement.hasAttribute('data-windows-titlebar')
  if (!titlebar && !hidden) return null
  const label = t(hidden ? 'Expand sidebar' : 'Collapse sidebar')
  return createPortal(h('button', {
    type: 'button',
    className: titlebar ? 'bt-title-toggle' : 'bt-round bt-title-toggle',
    'data-left': hidden ? 'hidden' : 'open',
    'aria-label': label,
    title: label,
    onClick: onToggle,
  }, h(SidebarIcon)), document.body)
}

// Fallback DynamicIsland connection indicator when HeaderPill is not mounted (Classic mode or empty state).
function StandaloneConnectionIsland({ useConnection, onReconnect }) {
  const conn = useConnection ? useConnection(state => state) : null
  const status = conn && conn.status !== 'connected' ? conn.status : null
  if (!status) return null
  return h('div', { className: 'dsb-head dsb-head-conn' },
    h(DynamicIsland, {
      pill: null,
      morphKey: `conn:${status}`,
      pods: [{ id: 'connection', node: h(ConnectionIslandPod, { status, onReconnect }), open: false }],
    }))
}

export function App() {
  const team = useMemo(createTeam, [])
  useEffect(() => team.start(), [team])
  const { hooks, actions } = team
  const views = { ...hooks, actions }
  const sidebarPref = hooks.useLayout(state => state.pref)
  const sidebarWidth = hooks.useLayout(state => state.width)
  const surfaceMode = hooks.useSurface(state => state.mode)
  const shown = hooks.useShown(id => id)
  const shortcutsOpen = hooks.useUi(state => state.shortcuts === true)
  const settingsOpen = hooks.useUi(state => Boolean(state.settings))
  const paletteOpen = hooks.useUi(state => Boolean(state.palette))
  const panelOpen = hooks.useUi(state => Boolean(state.details))
  const rightPanel = hooks.useUi(state => state.rightPanel)
  const readOnly = hooks.useRoster(value => Boolean(value.readOnly))
  const rosterReady = hooks.useRoster(value => Boolean(value.ready))
  const registryVersion = hooks.useRegistry(value => value)
  // Activate page-scoped UI plugins lazily as their pages open.
  usePluginPage('chat', Boolean(shown), pluginRuntime)
  usePluginPage('settings', settingsOpen, pluginRuntime)
  usePluginPage('right-panel', panelOpen || Boolean(rightPanel), pluginRuntime)
  // TeamSidebar calls dsBotApp.ready(place) in Bot mode; if the window boots directly into
  // Classic Agent mode (where TeamSidebar is unmounted), signal ready once the team arrives.
  useEffect(() => {
    if (surfaceMode === 'agent' && rosterReady) globalThis.dsBotApp?.ready?.()
  }, [surfaceMode, rosterReady])
  const [localeVersion, setLocaleVersion] = useState(0)
  useEffect(() => {
    const svc = getAppLocale()
    if (!svc?.subscribe) return undefined
    return svc.subscribe(() => {
      setLocaleVersion(v => v + 1)
      void actions.refreshLocale?.()
    })
  }, [actions])
  const dshBridge = useDshSettingsBridge(slots, {
    readOnly,
    surfaceMode,
    localeVersion,
    onRestoredSession: () => actions.refreshClassicSessions?.(),
    onStartPresetCreator: () => actions.startPresetCreator?.(),
  })
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window === 'undefined' ? 1280 : window.innerWidth))
  const [drawerOpen, setDrawerOpen] = useState(false)
  const drawerOpenRef = useRef(drawerOpen)
  drawerOpenRef.current = drawerOpen
  const mobileMenuRef = useRef(null)
  const restoreMobileMenuFocusRef = useRef(false)
  const openDrawer = useCallback(() => {
    drawerOpenRef.current = true
    restoreMobileMenuFocusRef.current = false
    setDrawerOpen(true)
  }, [])
  const closeDrawer = useCallback(({ restoreFocus = false } = {}) => {
    if (!drawerOpenRef.current) {
      if (!restoreFocus) restoreMobileMenuFocusRef.current = false
      return
    }
    drawerOpenRef.current = false
    restoreMobileMenuFocusRef.current = restoreFocus
    setDrawerOpen(false)
  }, [])
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const onResize = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const isNarrow = viewportWidth <= 768
  const inClassicMode = surfaceMode === 'agent'
  const classicHidden = inClassicMode && !isNarrow && sidebarPref === 'hidden'
  const effectiveSideW = isNarrow
    ? Math.min(sidebarWidth, Math.max(264, Math.round(viewportWidth * 0.84)))
    : Math.min(sidebarWidth, Math.max(264, viewportWidth - 420))
  useEffect(() => { closeDrawer() }, [shown, surfaceMode, closeDrawer])
  useEffect(() => { if (!isNarrow) closeDrawer() }, [isNarrow, closeDrawer])
  useLayoutEffect(() => {
    if (!isNarrow || drawerOpen || !restoreMobileMenuFocusRef.current) return
    restoreMobileMenuFocusRef.current = false
    const active = typeof document !== 'undefined' ? document.activeElement : null
    if (!active || active === document.body || active === document.documentElement || active.closest?.('.dsb-side,.bt-leftcol')) {
      mobileMenuRef.current?.focus?.()
    }
  }, [isNarrow, drawerOpen])
  useEscape(() => closeDrawer({ restoreFocus: true }), drawerOpen, { priority: ESCAPE_PRIORITY.DRAWER })
  const teamSidebarActions = useMemo(() => ({
    ...actions,
    toggleSidebar: undefined,
    setSidebarPref: (pref) => {
      if (isNarrow) {
        if (pref === 'open') openDrawer()
        else closeDrawer({ restoreFocus: true })
      } else actions.setSidebarPref(pref)
    },
    setSidebarWidth: (width) => actions.setSidebarWidth(width),
    setLeftDrawer: (next) => {
      if (isNarrow) {
        if (next) openDrawer()
        else closeDrawer({ restoreFocus: true })
      } else actions.setLeftDrawer(Boolean(next))
    },
    toggleLeftHidden: () => {
      if (isNarrow) {
        if (drawerOpenRef.current) closeDrawer({ restoreFocus: true })
        else openDrawer()
      } else actions.toggleLeftHidden()
    },
    openSession: (...args) => { closeDrawer(); return actions.openSession?.(...args) },
    openAgent: (...args) => { closeDrawer(); return actions.openAgent?.(...args) },
    openAgentSession: (...args) => { closeDrawer(); return actions.openAgentSession?.(...args) },
    newAgentSession: (...args) => { closeDrawer(); return actions.newAgentSession?.(...args) },
    openInbox: (...args) => { closeDrawer(); return actions.openInbox?.(...args) },
    openSettings: (...args) => { closeDrawer(); return actions.openSettings(...args) },
    selectPanel: (...args) => { closeDrawer(); return actions.selectPanel(...args) },
    openNewChat: (...args) => { closeDrawer(); return actions.openNewChat(...args) },
    openPalette: (...args) => { closeDrawer(); return actions.openPalette(...args) },
  }), [actions, isNarrow, openDrawer, closeDrawer])
  const classicSidebarActions = useMemo(() => ({
    ...actions,
    toggleSidebar: () => {
      if (isNarrow) closeDrawer({ restoreFocus: true })
      else actions.toggleLeftHidden()
    },
    openAgentSession: (...args) => { closeDrawer(); return actions.openAgentSession(...args) },
    newAgentSession: (...args) => { closeDrawer(); return actions.newAgentSession(...args) },
    addAgent: (...args) => { closeDrawer(); return actions.addAgent(...args) },
  }), [actions, isNarrow, closeDrawer])
  const useTeamUi = useMemo(
    () => makeTeamUiHook(hooks.useUi, isNarrow, drawerOpen),
    [hooks.useUi, isNarrow, drawerOpen],
  )
  // Bot mode renders `.dsb-frame[data-surface=bot]` as a single column and lets TeamSidebar's
  // portalled `.bt-leftcol` own left offset via `chatRoom.setLeft(pushed)`. Keeping collapsedWidth
  // at 0 on desktop makes `chatRoom.setLeft` the single source of truth for both layout and drag.
  const useOwnFrame = useMemo(() => {
    const snap = isNarrow
      ? { viewport: Math.min(viewportWidth, 680), sidebarWidth: effectiveSideW, collapsedWidth: drawerOpen ? 88 : 0 }
      : { viewport: viewportWidth, sidebarWidth: effectiveSideW, collapsedWidth: 0 }
    return selector => selector(snap)
  }, [isNarrow, viewportWidth, effectiveSideW, drawerOpen])
  const effectivePref = isNarrow
    ? (drawerOpen ? 'open' : 'hidden')
    : (inClassicMode && sidebarPref === 'rail' ? 'open' : sidebarPref)
  const useOwnSidebarPref = useMemo(
    () => selector => selector(effectivePref),
    [effectivePref],
  )
  const browserEnabled = hooks.useRoster(value => value.browser !== false)
  const isNarrowRef = useRef(isNarrow)
  isNarrowRef.current = isNarrow
  const [terminalFocusNonce, setTerminalFocusNonce] = useState(0)
  const terminalFocusSeqRef = useRef(0)
  const consumeTerminalFocus = useCallback((nonce) => {
    setTerminalFocusNonce(current => (current === nonce ? 0 : current))
  }, [])
  const capabilitiesOf = useCallback((rosterSnap, mode = 'bot') => {
    const classic = mode === 'agent'
    return {
      hasSurface: typeof actions.setSurface === 'function',
      hasBrowser: (typeof actions.toggleBrowser === 'function' || typeof actions.openBrowser === 'function') && rosterSnap?.browser !== false,
      hasInbox: !classic && typeof actions.openInbox === 'function',
      hasDetails: !classic,
      hasMemory: !classic,
      hasGroupSearch: !classic,
    }
  }, [actions])

  const runShortcut = useCallback((hit) => {
    if (!hit) return
    const uiSnap = team.snapshots?.ui?.() ?? {}
    const rosterSnap = team.snapshots?.roster?.() ?? {}
    const sessionsSnap = team.snapshots?.sessions?.() ?? {}
    const statusMap = team.snapshots?.status?.()
    const shownId = team.snapshots?.shown?.() ?? null
    const mode = team.snapshots?.surface?.()?.mode ?? 'bot'
    const isShortcutsOpen = uiSnap.shortcuts === true
    const isSettingsOpen = Boolean(uiSnap.settings)
    const isPaletteOpen = Boolean(uiSnap.palette)
    const focusComposerSoon = () => {
      const focus = () => {
        if (typeof document === 'undefined') return
        if (document.querySelector('[aria-modal="true"]')) return
        document.querySelector('[data-bt-composer-input]')?.focus?.()
      }
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focus)
      else focus()
    }

    if (hit === 'shortcuts') {
      if (isShortcutsOpen) actions.closeShortcuts()
      else actions.openShortcuts()
      return
    }
    if (isShortcutsOpen) actions.closeShortcuts()
    if (hit === 'palette') {
      if (isPaletteOpen) actions.closePalette()
      else actions.openPalette()
      return
    }
    if (hit === 'settings') {
      if (isSettingsOpen) actions.closeSettings()
      else actions.openSettings()
      return
    }
    if (hit === 'new-chat') {
      if (isSettingsOpen) actions.closeSettings()
      if (mode === 'agent') {
        void Promise.resolve(actions.createClassicSession?.()).catch(error => actions.reportError?.(error, 'agent-session'))
      } else {
        actions.openNewChat('new')
      }
      return
    }
    if (hit === 'sidebar') {
      if (isNarrowRef.current) {
        if (drawerOpenRef.current) closeDrawer({ restoreFocus: true })
        else openDrawer()
      } else actions.toggleSidebar()
      return
    }
    if (hit === 'switch-surface') {
      if (typeof actions.setSurface === 'function') {
        void Promise.resolve(actions.setSurface(mode === 'agent' ? 'bot' : 'agent')).catch(error => actions.reportError?.(error, 'surface'))
      }
      return
    }
    if (hit === 'inbox') {
      if (mode !== 'bot') return
      if (typeof actions.openInbox === 'function') {
        if (uiSnap.inbox) actions.closeInbox?.()
        else actions.openInbox()
      }
      return
    }
    if (hit === 'browser') {
      if (rosterSnap.browser === false) return
      const targetId = mode === 'agent'
        ? CLASSIC_BROWSER_OWNER
        : ((shownId ? rosterSnap.byId?.[shownId]?.id : null) ?? rosterSnap.mainBotId ?? rosterSnap.bots?.[0]?.id)
      if (typeof actions.toggleBrowser === 'function') {
        if (targetId) actions.toggleBrowser(targetId)
        return
      }
      if (typeof actions.openBrowser !== 'function') return
      const detailsBotId = uiSnap.details ? (rosterSnap.byId?.[uiSnap.details]?.id ?? uiSnap.details) : null
      if (uiSnap.details && uiSnap.view === 'browser' && (mode === 'agent' || !targetId || detailsBotId === targetId)) {
        actions.closePanel()
        return
      }
      if (targetId) actions.openBrowser(targetId)
      return
    }
    if (hit === 'right-panel') {
      if (uiSnap.details) actions.closePanel()
      else actions.toggleRightPanel?.()
      return
    }
    if (hit === 'terminal') {
      if (uiSnap.details && uiSnap.view === 'workspace' && uiSnap.rightPanel?.tab === 'terminal') {
        setTerminalFocusNonce(0)
        actions.closePanel()
      } else if (actions.canOpenTerminal?.() !== false) {
        terminalFocusSeqRef.current += 1
        setTerminalFocusNonce(terminalFocusSeqRef.current)
        actions.setRightPanelTab?.('terminal')
      }
      return
    }
    if (hit === 'details') {
      const target = shownId ? (rosterSnap.byId?.[shownId]?.id ?? rosterSnap.roomsById?.[shownId]?.id) : null
      if (target) actions.toggleDetails?.(target)
      return
    }
    if (hit === 'memory') {
      if (uiSnap.memory) {
        actions.closeMemory?.()
        return
      }
      const target = shownId ? (rosterSnap.byId?.[shownId]?.id ?? rosterSnap.roomsById?.[shownId]?.id) : null
      if (target && rosterSnap.memory !== false) actions.openMemory?.(target)
      return
    }
    if (hit === 'focus-composer') {
      focusComposerSoon()
      return
    }
    if (hit === 'group-search') {
      if (uiSnap.groupSearch) {
        actions.closeGroupSearch?.()
        return
      }
      const room = shownId ? rosterSnap.roomsById?.[shownId] : null
      if (room && typeof actions.openGroupSearch === 'function') actions.openGroupSearch(room.id)
      else actions.openPalette()
      return
    }
    if (hit === 'stop-turn') {
      if (!shownId) return
      const room = rosterSnap.roomsById?.[shownId]
      const bot = rosterSnap.byId?.[shownId]
      const agentId = !bot && !room ? rosterSnap.agentOf?.[shownId] : null
      if (room && typeof actions.stopRoomWork === 'function') {
        if (statusMap && statusMap.get(shownId)?.running !== true) return
        void Promise.resolve(actions.stopRoomWork(room.id)).catch(error => actions.reportError?.(error, 'stop'))
      } else if (bot && typeof actions.stopChat === 'function') {
        if (statusMap && statusMap.get(shownId)?.running !== true) return
        void Promise.resolve(actions.stopChat(bot.id)).catch(error => actions.reportError?.(error, 'stop'))
      } else if (agentId && typeof actions.stopAgent === 'function') {
        if (statusMap && statusMap.get(shownId)?.running !== true) return
        void Promise.resolve(actions.stopAgent(agentId, shownId)).catch(error => actions.reportError?.(error, 'stop'))
      }
      return
    }
    if (hit === 'prev-chat' || hit === 'next-chat' || hit.startsWith('switch-bot-')) {
      const delta = hit === 'prev-chat' ? -1 : hit === 'next-chat' ? 1 : 0
      const slot = hit.startsWith('switch-bot-') ? Number(hit.slice('switch-bot-'.length)) - 1 : -1
      if (mode === 'agent') {
        const list = visibleClassicSessions(rosterSnap, sessionsSnap.byId)
        if (list.length === 0) return
        let target = null
        if (slot >= 0) target = list[slot] ?? null
        else {
          const currentIndex = list.findIndex(item => item.id === shownId)
          const nextIndex = currentIndex < 0 ? 0 : (currentIndex + delta + list.length) % list.length
          target = list[nextIndex]
        }
        if (target) {
          actions.openAgentSession?.(target.id)
          focusComposerSoon()
        }
        return
      }
      const targets = visibleSidebarTargets(rosterSnap, sessionsSnap.byId, shownId, uiSnap.sectionFolds)
      if (targets.length === 0) return
      let target = null
      if (slot >= 0) {
        target = targets[slot] ?? null
      } else {
        const currentEntityId = shownId
          ? (rosterSnap.byId?.[shownId]?.id ?? rosterSnap.roomsById?.[shownId]?.id ?? rosterSnap.agentOf?.[shownId] ?? shownId)
          : null
        const currentIndex = targets.findIndex(item => item.id === currentEntityId)
        const nextIndex = currentIndex < 0 ? 0 : (currentIndex + delta + targets.length) % targets.length
        target = targets[nextIndex]
      }
      if (target) {
        if (target.kind === 'agent') actions.openAgent?.(target.id)
        else actions.openSession(target.id)
        focusComposerSoon()
      }
    }
  }, [team, actions])

  // Priority follows actual modal z-index stacking (75 shortcuts > 70 palette/groupSearch > 66 releaseNotes > 61 memory > 60 settings > dialogs > inbox).
  const activeModalOf = useCallback(resolveActiveModal, [])

  const runShortcutRef = useRef(runShortcut)
  runShortcutRef.current = runShortcut

  useEffect(() => {
    const readContext = () => {
      const uiSnap = team.snapshots?.ui?.() ?? {}
      const rosterSnap = team.snapshots?.roster?.() ?? {}
      const mode = team.snapshots?.surface?.()?.mode ?? 'bot'
      return {
        settingsOpen: Boolean(uiSnap.settings),
        modal: activeModalOf(uiSnap),
        capabilities: capabilitiesOf(rosterSnap, mode),
      }
    }
    const clearLiveContext = setLiveShortcutContext(readContext)
    const onKeyDown = (event) => {
      const hit = matchGlobalShortcut(event, readContext())
      if (!hit) return
      event.preventDefault()
      runShortcutRef.current(hit)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      clearLiveContext()
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [team, activeModalOf, capabilitiesOf])

  // Keep Electron's main process aware of active global bindings so shortcuts pressed inside
  // a focused Bot browser WebContentsView still reach the window without churn on chat switches.
  const hasSurfaceCap = typeof actions.setSurface === 'function'
  const hasInboxCap = typeof actions.openInbox === 'function'
  useEffect(() => {
    const bridge = globalThis.dsBotApp
    if (!bridge) return undefined
    const push = () => {
      const rosterSnap = team.snapshots?.roster?.() ?? {}
      const mode = team.snapshots?.surface?.()?.mode ?? 'bot'
      bridge.syncShortcuts?.(shortcutsStore.activeBindings(capabilitiesOf(rosterSnap, mode)))
    }
    push()
    const offStore = shortcutsStore.subscribe(push)
    const offShortcut = bridge.onShortcut?.((id) => {
      if (isShortcutRecording()) return
      const def = SHORTCUT_BY_ID[id]
      const rosterSnap = team.snapshots?.roster?.() ?? {}
      const mode = team.snapshots?.surface?.()?.mode ?? 'bot'
      if (!def || !isCommandAvailable(def, capabilitiesOf(rosterSnap, mode))) return
      const uiSnap = team.snapshots?.ui?.() ?? {}
      const modal = activeModalOf(uiSnap)
      if (modal && !(def.allowInModal && def.allowInModal.includes(modal))) return
      runShortcutRef.current(id)
    })
    return () => {
      offStore()
      if (typeof offShortcut === 'function') offShortcut()
    }
  }, [team, activeModalOf, capabilitiesOf, browserEnabled, hasSurfaceCap, hasInboxCap, inClassicMode])
  const prefs = hooks.useRoster(value => value.prefs)
  const bots = hooks.useRoster(value => value.bots)
  // The open chat's own background, over the team's.
  const chat = hooks.useRoster(value => (shown ? value.byId?.[shown] ?? value.roomsById?.[shown] : undefined))
  const shownAgent = hooks.useRoster((value) => {
    if (!shown || value.byId?.[shown] || value.roomsById?.[shown]) return undefined
    const agentId = value.agentOf?.[shown]
    return agentId ? value.agentsById?.[agentId] : undefined
  })
  const shownSessionTitle = hooks.useSessions((list) => {
    if (!shown) return ''
    const row = list.byId?.[shown]
    if (!row || row.blank === true) return ''
    return row.displayTitle || row.title || ''
  })
  useWindowTitle(conversationTitleOf({ shown, chat, shownAgent, sessionTitle: shownSessionTitle }))
  useTheme(prefs, chat, actions, registryVersion)
  useMentions(bots, registryVersion)
  const closeOverlays = (error) => {
    actions.closeSettings()
    actions.closeReleaseNotes?.()
    actions.closeMemory()
    actions.closeMenu()
    actions.closePanel()
    actions.closePalette()
    actions.closeVoice()
    actions.closeShortcuts()
    actions.closeSignIn?.()
    actions.closeInbox?.()
    actions.closeOverlay()
    actions.reportError(error, 'overlay')
  }
  const closeWorkspace = useCallback((error) => {
    actions.closePanel()
    actions.reportError(error, 'workspace')
  }, [actions])
  const rightPluginEntries = useSlotEntries(slots, RIGHT_PANE_TAB_SLOT)
  const workspaceTabs = useMemo(
    () => buildWorkspaceTabs(rightPanel, rightPluginEntries),
    [rightPanel, rightPluginEntries, localeVersion],
  )
  useEffect(() => {
    if (terminalFocusNonce > 0 && rightPanel?.tab !== 'terminal') {
      setTerminalFocusNonce(0)
    }
  }, [terminalFocusNonce, rightPanel?.tab])
  const workspace = useMemo(() => ({
    tabs: workspaceTabs,
    active: rightPanel?.tab ?? null,
    browserId: inClassicMode && browserEnabled && typeof actions.browserShow === 'function' ? CLASSIC_BROWSER_OWNER : null,
    onSelect: tabId => actions.setRightPanelTab(tabId),
    onCloseTab: tabId => actions.closeWorkspaceTab(tabId),
    render: (_activeTabId, visible) => h(Contain, { onError: closeWorkspace },
      h(WorkspacePaneBody, {
        sessionId: shown,
        panel: rightPanel,
        team,
        registry: slots,
        readOnly,
        visible,
        terminalFocusNonce,
        onConsumeTerminalFocus: consumeTerminalFocus,
      })),
  }), [workspaceTabs, rightPanel, inClassicMode, browserEnabled, actions, closeWorkspace, shown, team, readOnly, terminalFocusNonce, consumeTerminalFocus])
  const dialogCaps = capabilitiesOf({ browser: browserEnabled }, surfaceMode)
  // Key the conversation by stable Bot/room id so segment rollovers and initial roster
  // hydration on a rolled-over segment both preserve unsent drafts and composer focus.
  const chatKeyRef = useRef({ shown: null, chatId: null, key: null })
  const chatId = chat?.id ?? null
  let chatKey = chatId ?? shown
  let nextChatKeyState = { shown: null, chatId: null, key: null }
  if (shown) {
    const prev = chatKeyRef.current
    const same = prev.key !== null && (
      prev.shown === shown
      || (chatId !== null && prev.chatId === chatId)
    )
    if (same) chatKey = prev.key
    nextChatKeyState = { shown, chatId: same ? (chatId ?? prev.chatId) : chatId, key: chatKey }
  }
  useLayoutEffect(() => {
    chatKeyRef.current = nextChatKeyState
  }, [nextChatKeyState.shown, nextChatKeyState.chatId, nextChatKeyState.key])
  return h('div', {
    className: 'dsb-frame',
    style: { '--dsb-side-w': `${effectiveSideW}px` },
    'data-collapsed': classicHidden ? '' : undefined,
    'data-drawer-open': drawerOpen ? '' : undefined,
    'data-surface': surfaceMode,
  },
  drawerOpen ? h('div', { className: 'dsb-drawer-scrim', 'aria-hidden': true, onClick: () => closeDrawer({ restoreFocus: true }) }) : null,
  inClassicMode
    ? h(Fragment, null,
      isNarrow ? null : h(ClassicTitleToggle, { hidden: classicHidden, onToggle: () => actions.toggleLeftHidden() }),
      classicHidden
        ? null
        : h('aside', { className: 'dsb-side' },
          h('div', { className: 'dsb-band' }),
          h('div', { className: 'dsb-side-list' },
            h(ClassicSidebar, { ...views, actions: classicSidebarActions, wide: true })),
          h('div', { className: 'dsb-side-foot' },
            h('button', {
              type: 'button',
              className: 'dsb-settings',
              'aria-label': t('Settings'),
              title: t('Settings'),
              onClick: () => { closeDrawer(); actions.openSettings() },
            }, h(YouAvatar)),
            h(BotReturn, { ...views, wide: true }))))
    : h(TeamSidebar, {
      ...views,
      useUi: useTeamUi,
      actions: teamSidebarActions,
      useFrame: useOwnFrame,
      useSidebarPref: useOwnSidebarPref,
      wide: effectivePref === 'open',
      hideTitleToggle: isNarrow,
    }),
  // The unified right panel makes room by giving `[data-bt-center]` a right margin.
  h('main', { className: 'dsb-main', 'data-bt-center': '', 'data-classic': shownAgent ? '' : undefined },
    h('div', { className: 'dsb-band' }),
    (!shown || shownAgent) ? h(StandaloneConnectionIsland, { useConnection: hooks.useConnection, onReconnect: actions.reconnectFeed }) : null,
    isNarrow && !drawerOpen ? h('button', {
      ref: mobileMenuRef,
      type: 'button', className: 'dsb-mobile-menu', 'aria-label': t('Expand sidebar'), 'aria-expanded': false,
      onClick: openDrawer,
    }, h(SidebarIcon)) : null,
    shown ? h(Fragment, { key: chatKey },
      h('div', { className: shownAgent ? 'dsb-head dsb-head-classic' : 'dsb-head' },
        shownAgent
          ? h(ClassicHeader, {
            sessionId: shown,
            agent: shownAgent,
            useSessions: hooks.useSessions,
            useSessionStatus: hooks.useSessionStatus,
            useUi: hooks.useUi,
            actions,
            readOnly,
            sidebarWide: isNarrow ? drawerOpen : !classicHidden,
          })
          : h(HeaderPill, { ...views, sessionId: shown, useSession: team.sessionHook(shown), useConnection: hooks.useConnection, onReconnect: actions.reconnectFeed, PendingLearning })),
      h(Chat, { key: chatKey, sessionId: shown, team, classic: Boolean(shownAgent) }))
      : (inClassicMode
        ? h('div', { className: 'dsb-classic-none' }, h(AgentEmptyHero, { actions, readOnly, noSession: true }))
        : (rosterReady ? h('div', { className: 'bt-empty' }, t('Setting up your Main Bot…')) : null))),
  h(Contain, { onError: closeOverlays },
    h(Overlays, { ...views, useFrame: useOwnFrame, useSidebarPref: useOwnSidebarPref, workspace, dsh: dshBridge }),
    h(DeepSeekSignIn, views),
    h(ShortcutsDialog, {
      open: shortcutsOpen,
      enterToSend: sendsOnEnter(prefs),
      classic: inClassicMode,
      ...dialogCaps,
      onCustomize: () => actions.openSettings('shortcuts'),
      onClose: actions.closeShortcuts,
    }),
    h(ShellOverlayHost, { registry: slots, views })),
  h(ReloadConfirmHost),
  h(ErrorToast, views))
}
