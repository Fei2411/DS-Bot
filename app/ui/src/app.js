import { Component, createElement as h, Fragment, useEffect, useMemo, useState } from 'react'
import { sendsOnEnter } from '../../../ds-bot/src/client/enter-key.js'
import { ErrorToast } from '../../../ds-bot/src/client/feedback.js'
import { HeaderPill } from '../../../ds-bot/src/client/header.js'
import { t } from '../../../ds-bot/src/client/i18n.js'
import { SidebarIcon } from '../../../ds-bot/src/client/icons.js'
import { Overlays } from '../../../ds-bot/src/client/overlays.js'
import { useEscape } from '../../../ds-bot/src/client/overlay-hooks.js'
import { BrandMark, TeamSidebar, YouAvatar } from '../../../ds-bot/src/client/sidebar.js'
import { allThemes, effectsOf, flatWidthOf, layoutOf, themeCss, themesOf, widthOf } from '../../../ds-bot/src/client/themes.js'
import { appearanceCss, onSafeAppearance, pictureUrl, safeAppearance, watchSafeAppearance } from '../../../ds-bot/src/client/appearance.js'
import { call } from '../../../ds-bot/src/client/api.js'
import { readAppearance } from '../../../ds-bot/src/shared/appearance.js'
import { paintMode } from './mode.js'
import { Chat } from './chat.js'
import { ShortcutsDialog, matchGlobalShortcut } from './shortcuts.js'
import { createTeam } from './team.js'

// The team's theme, accent and appearance. The window owns fonts, sizes and light or dark
// here; in DSH those are DSH's settings (docs/plans/2026-11-21-appearance.md).
function useTheme(prefs, chat, actions) {
  const [loaded, setLoaded] = useState(0)
  const [safe, setSafe] = useState(safeAppearance)
  useEffect(() => onSafeAppearance((on) => {
    setSafe(on)
    if (on) actions.notice?.(t('Safe appearance: the background and your stylesheet are off in this window. Turn them back on in Settings → Appearance.'))
  }), [])
  useEffect(() => watchSafeAppearance(), [])
  useEffect(() => {
    const theme = themesOf(prefs)[prefs?.theme] ?? allThemes().deepseek
    const style = document.createElement('style')
    style.textContent = themeCss(theme, prefs?.accent) + '\n' + appearanceCss({
      appearance: prefs?.appearance, theme, background: chat?.background, fonts: true, safe,
      pictureUrl: id => pictureUrl(id, call, () => setLoaded(count => count + 1)),
    })
    document.head.append(style)
    if (prefs?.motion) document.body.dataset.btMotion = prefs.motion
    else delete document.body.dataset.btMotion
    document.body.dataset.btEffects = effectsOf(prefs)
    document.body.dataset.btLayout = layoutOf(prefs)
    document.body.style.setProperty('--bt-msg-w', String(widthOf(prefs) / 100))
    document.body.style.setProperty('--bt-flat-w', String(flatWidthOf(prefs) / 100))
    return () => {
      delete document.body.dataset.btEffects
      delete document.body.dataset.btLayout
      document.body.style.removeProperty('--bt-msg-w')
      document.body.style.removeProperty('--bt-flat-w')
      style.remove()
    }
  }, [prefs, chat?.background, safe, loaded])
  const mode = readAppearance(prefs?.appearance).mode
  useEffect(() => paintMode(mode), [mode])
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

export function App() {
  const team = useMemo(createTeam, [])
  useEffect(() => team.start(), [team])
  const { hooks, actions } = team
  const views = { ...hooks, actions }
  const wide = hooks.useLayout(state => state.wide)
  const shown = hooks.useShown(id => id)
  const shortcutsOpen = hooks.useUi(state => state.shortcuts === true)
  const settingsOpen = hooks.useUi(state => Boolean(state.settings))
  const paletteOpen = hooks.useUi(state => Boolean(state.palette))
  const [drawerOpen, setDrawerOpen] = useState(false)
  useEffect(() => { setDrawerOpen(false) }, [shown])
  useEscape(() => setDrawerOpen(false), drawerOpen)
  useEffect(() => {
    const onKeyDown = (event) => {
      const hit = matchGlobalShortcut(event, { settingsOpen })
      if (!hit) return
      event.preventDefault()
      if (hit === 'shortcuts') {
        if (shortcutsOpen) actions.closeShortcuts()
        else actions.openShortcuts()
        return
      }
      if (shortcutsOpen) actions.closeShortcuts()
      if (hit === 'palette') {
        if (paletteOpen) actions.closePalette()
        else actions.openPalette()
      } else if (hit === 'settings') {
        if (settingsOpen) actions.closeSettings()
        else actions.openSettings()
      } else if (hit === 'new-chat') {
        if (settingsOpen) actions.closeSettings()
        actions.openNewChat('new')
      } else if (hit === 'sidebar') actions.toggleSidebar()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [actions, settingsOpen, shortcutsOpen, paletteOpen])
  const prefs = hooks.useRoster(value => value.prefs)
  // The open chat's own background, over the team's.
  const chat = hooks.useRoster(value => (shown ? value.byId?.[shown] ?? value.roomsById?.[shown] : undefined))
  useTheme(prefs, chat, actions)
  const closeOverlays = (error) => {
    actions.closeSettings()
    actions.closeMemory()
    actions.closeMenu()
    actions.closePanel()
    actions.closePalette()
    actions.closeVoice()
    actions.closeShortcuts()
    actions.closeOverlay()
    actions.reportError(error, 'overlay')
  }
  // Key the conversation by stable Bot/room id so segment rollovers preserve unsent drafts.
  const chatKey = chat?.id ?? shown
  return h('div', { className: 'dsb-frame', 'data-rail': wide ? undefined : '', 'data-drawer-open': drawerOpen ? '' : undefined },
    drawerOpen ? h('div', { className: 'dsb-drawer-scrim', 'aria-hidden': true, onClick: () => setDrawerOpen(false) }) : null,
    h('aside', { className: 'dsb-side' },
      h('div', { className: 'dsb-band' }),
      h('div', { className: 'dsb-side-list' },
        wide ? null : h('button', { type: 'button', className: 'dsb-expand', 'aria-label': t('Expand sidebar'), title: t('Expand sidebar'), onClick: () => actions.toggleSidebar() }, h(BrandMark, { size: 22 })),
        h(TeamSidebar, { ...views, wide: wide || drawerOpen })),
      h('div', { className: 'dsb-side-foot' },
        h('button', { type: 'button', className: 'dsb-settings', title: t('Settings'), onClick: () => { setDrawerOpen(false); actions.openSettings() } }, h(YouAvatar)))),
    // The details panel makes room by giving the shell's `_centerCol` column a right margin.
    h('main', { className: 'dsb-main dsb_centerCol' },
      h('div', { className: 'dsb-band' }),
      h('button', {
        type: 'button', className: 'dsb-mobile-menu', 'aria-label': t('Expand sidebar'), 'aria-expanded': drawerOpen,
        onClick: () => setDrawerOpen(open => !open),
      }, h(SidebarIcon)),
      shown ? h(Fragment, { key: chatKey },
        h('div', { className: 'dsb-head' }, h(HeaderPill, { ...views, sessionId: shown, useSession: team.sessionHook(shown) })),
        h(Chat, { key: chatKey, sessionId: shown, team })) : null),
    h(Contain, { onError: closeOverlays },
      h(Overlays, views),
      h(ShortcutsDialog, { open: shortcutsOpen, enterToSend: sendsOnEnter(prefs), onClose: actions.closeShortcuts })),
    h(ErrorToast, views))
}
