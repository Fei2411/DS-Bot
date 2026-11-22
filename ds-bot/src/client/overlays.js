import { createElement as h, Fragment, useEffect, useRef, useState } from 'react'
import { NotificationWatcher } from './notifications.js'
import { createPortal } from 'react-dom'
import { CommandPalette } from './palette.js'
import { GroupSearch } from './group-search.js'
import { NewChat } from './new-chat.js'
import { ExchangeDialog } from './exchange.js'
import { VoiceMode } from './voice.js'
import { SettingsDialog } from './settings.js'
import { ContextMenu } from './context-menu.js'
import { PANEL_LINGER_MS, BotPanel } from './browser-pane.js'
import { frameLayout, FALLBACK_SIDEBAR_WIDTH } from './frame-layout.js'
import { MemoryDialog } from './memory-panel.js'
import { reducedMotion, useLinger } from './motion.js'
import { OpeningCover, openingModel } from './opening.js'
import { OverlayBoundary } from './overlay-boundary.js'

// How long a closing dialog or menu stays for its exit (see their [data-leaving] CSS).
const DIALOG_EXIT_MS = 160
const MENU_EXIT_MS = 120

const useDefaultFrame = () => ({ viewport: typeof window === 'undefined' ? 0 : window.innerWidth, sidebarWidth: FALLBACK_SIDEBAR_WIDTH, collapsedWidth: 0 })
const useDefaultSidebarPref = () => 'open'
const useDefaultFalse = () => false

export function Overlays({ useRoster, useUi, useSessions, useSessionStatus, useActivity, useWork, useComputer, useRegistry, useBrowserPages, useBrowserTabs, useBrowserHolds, useUpdate, useFrame, useSidebarPref, useSettingsShellHeld, actions }) {
  const roster = useRoster(value => value)
  const ui = useUi(value => value)
  useRegistry(value => value)
  const useReadFrame = useFrame ?? useDefaultFrame
  const useReadSidebarPref = useSidebarPref ?? useDefaultSidebarPref
  const useReadSettingsShellHeld = useSettingsShellHeld ?? useDefaultFalse
  const frameSnap = useReadFrame(value => value)
  const pref = useReadSidebarPref(value => value)
  const current = useSessions(list => Object.values(list.byId).find(session => (session?.retainedBy?.mainView ?? 0) > 0)?.id ?? null)
  // An open panel follows the conversation in the main view. Only a change of the
  // main view moves it, so opening details for another id (Rename) is not undone.
  const previous = useRef(current)
  useEffect(() => {
    if (previous.current === current) return
    previous.current = current
    if (current) actions.followPanel?.(current)
  }, [current])
  const open = ui.details ? { id: ui.details, view: ui.view ?? 'details', renaming: ui.renaming, tab: ui.tab, side: ui.side, task: ui.task } : null
  // A panel that no longer fits folds away: its state stays open, it just is not
  // mounted — the usual exit plays and the webview goes with it — until the room
  // returns and it shows again on its own.
  const layout = frameLayout({
    viewport: frameSnap.viewport, sidebarWidth: frameSnap.sidebarWidth,
    pref, drawer: ui.leftDrawer === true,
    panel: open ? { view: open.view, yielded: ui.panelYield === true } : null,
  })
  const shown = open !== null && layout.panel !== 'folded' ? open : null
  const [kept, setKept] = useState(shown)
  useEffect(() => {
    if (shown) { setKept(shown); return undefined }
    const timer = setTimeout(() => setKept(null), reducedMotion() ? 0 : PANEL_LINGER_MS)
    return () => clearTimeout(timer)
  }, [ui.details, ui.view, ui.renaming, ui.tab, ui.task, shown === null])
  const pane = shown ?? kept
  // The settings shell draws the dialog while DS Bot holds the seat.
  const shellHeld = useReadSettingsShellHeld(value => value)
  const [settings, settingsLeaving] = useLinger(shellHeld ? null : ui.settings, DIALOG_EXIT_MS)
  // The memory dialog shows a Bot's memory or a group chat's.
  const memoryOwner = (id) => {
    const bot = roster.byId[id]
    if (bot) return { id: bot.id, name: bot.name }
    const room = roster.roomsById[id]
    return room ? { id: room.id, name: room.name, group: true } : null
  }
  const [memory, memoryLeaving] = useLinger(ui.memory && memoryOwner(ui.memory) ? ui.memory : null, DIALOG_EXIT_MS)
  const owner = memory ? memoryOwner(memory) : null
  const [menu, menuLeaving] = useLinger(ui.menu, MENU_EXIT_MS)
  // A Session the Host made a moment ago is not in the shell's list yet: the asked-for
  // Bot fills the conversation area instead of the chat that was there before.
  const opening = openingModel({ pending: ui.pendingOpen ?? null, current, roster })
  const paletteToken = ui.palette?.token
  const groupSearchToken = ui.groupSearch?.token
  return h(Fragment, null,
    h(OverlayBoundary, { key: 'ds-bot:notifications', name: 'notifications', notify: false },
      h(NotificationWatcher, { useSessions, useSessionStatus, useRoster, useWork, actions })),
    opening ? h(OverlayBoundary, { name: 'opening', reset: opening.id, notify: false },
      createPortal(h(OpeningCover, { model: opening, column: layout.column }), document.body)) : null,
    pane ? h(OverlayBoundary, {
      name: 'panel', active: shown !== null, notify: shown !== null,
      reset: `${pane.id}:${pane.view}:${pane.tab ?? ''}:${pane.side ?? ''}:${pane.task?.botId ?? ''}:${pane.task?.taskId ?? ''}`,
      onDismiss: () => actions.closePanel?.(), actions,
    }, createPortal(h(BotPanel, { pane, leaving: shown === null, room: layout.room, overlay: layout.panel === 'overlay', roster, actions, useSessions, useSessionStatus, useActivity, useWork, useComputer, useBrowserTabs, useBrowserPages, useBrowserHolds }), document.body)) : null,
    ui.newChat ? h(OverlayBoundary, {
      name: 'new-chat', reset: `${ui.newChat}:${ui.newChatSection ?? ''}`,
      onDismiss: () => (actions.closeNewChat ?? actions.closeOverlay)?.(), actions,
    }, createPortal(h(NewChat, { key: `${ui.newChat}:${ui.newChatSection ?? ''}`, mode: ui.newChat, sectionId: ui.newChatSection ?? null, paneLeft: layout.column, roster, actions }), document.body)) : null,
    ui.palette ? h(OverlayBoundary, {
      name: 'palette', reset: paletteToken,
      onDismiss: () => actions.closePalette?.(paletteToken), actions,
    }, createPortal(h(CommandPalette, { key: ui.palette.token, start: ui.palette.query, token: ui.palette.token, roster, actions, useSessions }), document.body)) : null,
    ui.groupSearch && roster.roomsById[ui.groupSearch.roomId]
      ? h(OverlayBoundary, {
          name: 'group-search', reset: groupSearchToken,
          onDismiss: () => actions.closeGroupSearch?.(groupSearchToken), actions,
        }, createPortal(h(GroupSearch, { key: ui.groupSearch.token, room: roster.roomsById[ui.groupSearch.roomId], roster, token: ui.groupSearch.token, actions }), document.body))
      : null,
    ui.exchange ? h(OverlayBoundary, {
      name: 'exchange', reset: Array.isArray(ui.exchange) ? ui.exchange.join(':') : String(ui.exchange),
      onDismiss: () => (actions.closeExchange ?? actions.closeOverlay)?.(), actions,
    }, createPortal(h(ExchangeDialog, { pair: ui.exchange, paneLeft: layout.column, roster, actions }), document.body)) : null,
    ui.voice ? h(OverlayBoundary, {
      name: 'voice', reset: ui.voice,
      onDismiss: () => actions.closeVoice?.(), actions,
    }, createPortal(h(VoiceMode, { key: ui.voice, sessionId: ui.voice, paneLeft: layout.column, roster, actions, useSessions, useSessionStatus }), document.body)) : null,
    menu ? h(OverlayBoundary, {
      name: 'menu', active: !menuLeaving, notify: !menuLeaving,
      reset: `${menu.kind ?? ''}:${menu.id}:${menu.x}:${menu.y}`,
      onDismiss: () => actions.closeMenu?.(), actions,
    }, createPortal(h(ContextMenu, { key: `${menu.kind ?? ''}:${menu.id}:${menu.x}:${menu.y}`, menu, roster, actions, useWork, leaving: menuLeaving }), document.body)) : null,
    settings ? h(OverlayBoundary, {
      name: 'settings', active: !settingsLeaving, notify: !settingsLeaving,
      reset: `${settings.page}:${settings.id ?? ''}`,
      onDismiss: () => actions.closeSettings?.(), actions,
    }, createPortal(h(SettingsDialog, { page: settings.page, id: settings.id, roster, actions, useUpdate, leaving: settingsLeaving }), document.body)) : null,
    owner ? h(OverlayBoundary, {
      name: 'memory', active: !memoryLeaving, notify: !memoryLeaving,
      reset: owner.id,
      onDismiss: () => actions.closeMemory?.(), actions,
    }, createPortal(h(MemoryDialog, { key: owner.id, owner, actions, leaving: memoryLeaving }), document.body)) : null)
}
