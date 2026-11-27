// The Bot panel: one right-hand column holding a Bot's details, its browser or a
// side chat. A tab strip on top flips between them — the Bot page collapses to a
// tab, each browser tab and side chat is a tab of its own. Browser pages are
// Electron webviews kept in a body-level layer by bot-browsers.js; the panel
// draws the strip and the toolbar and reports the rectangle the shown webview
// covers.
import { createElement as h, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { BotMark } from './mark.js'
import { STORAGE } from './storage.js'
import { MIN_CHAT } from './frame-layout.js'
import { chatRoom } from './frame-watch.js'
import { SPRING_LEAD, SPRING_POP, SPRING_SHAPE, SPRING_TAP, SPRING_TRAIL, reducedMotion, spring, stepMenuFocus, useLinger, useMorph } from './motion.js'
import { FLIGHT_ENDS, INTENT_MS, createFlight, flightEnd, flightStart, planFlight, uniqueIds } from './mark-flight.js'
import { DetailsDrawer } from './details-drawer.js'
import { SideChatView } from './side-chat.js'
import { TaskReaderView } from './bot-tasks.js'
import { panelHasStrip, sideChatsOf, stripMenuKeys } from './side-model.js'
import { FolderIcon, SideIcon, TerminalIcon } from './icons.js'
import { ImportCard, ImportMenu, PreviewCard, RemoteDebugCard, SafariPermissionCard, orderImportSources, siteMatchesHost, useCookieImportFlow } from './cookie-import-ui.js'
import { t } from './i18n.js'
import { rectsOverlap } from './browser-overlap.js'
import { ESCAPE_PRIORITY, topEscapePriority, useEscape } from './overlay-hooks.js'

export { ImportCard, ImportMenu, PreviewCard, RemoteDebugCard, SafariPermissionCard, orderImportSources, siteMatchesHost }

export const PANEL_LINGER_MS = 300
const WIDTH_KEY = STORAGE.browserWidth
// One width for the panel, shared by both views. The Bot page keeps it within
// DETAILS_WIDTH..DETAILS_MAX, so a wider browser comes back to DETAILS_MAX and a
// narrower one keeps its width; the browser takes any width from MIN_WIDTH.
const DEFAULT_WIDTH = 520
const DEFAULT_WORKSPACE_WIDTH = 440
const DETAILS_WIDTH = 320
const DETAILS_MAX = 520
const MIN_WIDTH = 360
// How long the Bot's mark shows that it read the page.
const READ_FLASH_MS = 2400
const EMPTY_PAGE = { url: '', title: '', favicon: null, loading: false, canGoBack: false, canGoForward: false, error: null, excerpt: '' }
const EMPTY_TABS = { ids: [], active: null }

const icon = (paths, strokeWidth = 1.5) => function BrowserIcon() {
  return h('svg', { width: 16, height: 16, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    paths.map((d, index) => h('path', { key: index, d })))
}
export const GlobeIcon = icon(['M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M3 10h14', 'M10 3c2 2.2 2.9 4.5 2.9 7S12 14.8 10 17c-2-2.2-2.9-4.5-2.9-7S8 5.2 10 3z'])
const BackIcon = icon(['M12.5 4.5L7 10l5.5 5.5'])
const ForwardIcon = icon(['M7.5 4.5L13 10l-5.5 5.5'])
const ReloadIcon = icon(['M15.5 10a5.5 5.5 0 1 1-1.6-3.9', 'M15.5 3.5v3.5H12'])
const StopIcon = icon(['M5.5 5.5l9 9M14.5 5.5l-9 9'])
const CloseIcon = icon(['M5.5 5.5l9 9M14.5 5.5l-9 9'])
export const PlusTabIcon = icon(['M10 4.5v11M4.5 10h11'], 1.75)
const LockIcon = icon(['M6.5 9V7a3.5 3.5 0 0 1 7 0v2', 'M5.5 9h9v7h-9z'])
const ImportIcon = icon(['M10 3.5v8', 'M6.75 8.5L10 11.75l3.25-3.25', 'M4.5 13.25v1.25A1.5 1.5 0 0 0 6 16h8a1.5 1.5 0 0 0 1.5-1.5v-1.25'])

/** A page's favicon, or the globe while there is none or it fails to load. */
export function Favicon({ src, className }) {
  const [failed, setFailed] = useState(null)
  if (!src || failed === src) return h('span', { className: `${className} bt-ptab-globe` }, h(GlobeIcon))
  return h('img', { className, src, alt: '', 'aria-hidden': true, onError: () => setFailed(src) })
}

// null until the user sets a width: the Bot page then opens at DETAILS_WIDTH and the
// browser at DEFAULT_WIDTH.
const savedWidth = () => {
  try {
    const value = Number(localStorage.getItem(WIDTH_KEY))
    return Number.isFinite(value) && value >= DETAILS_WIDTH ? value : null
  } catch { return null }
}
// `room` is what the panel and the conversation share: the viewport minus the
// left column's footprint (frame-layout.js). The panel never takes the last
// MIN_CHAT px of it; below that it covers the conversation instead.
const widthRange = (view, room) => (view === 'browser' || view === 'workspace'
  ? [MIN_WIDTH, room - MIN_CHAT]
  : [DETAILS_WIDTH, Math.min(DETAILS_MAX, room - MIN_CHAT)])
const fitWidth = (width, [low, high]) => Math.round(Math.max(low, Math.min(width, high)))
const attrValue = value => String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')
// The address as the bar shows it while not editing: no scheme, no trailing slash.
const isBlankUrl = url => !url || url === 'about:blank' || String(url).startsWith('about:blank#')
const visibleUrl = url => (isBlankUrl(url) ? '' : String(url))
const shortAddress = url => visibleUrl(url).replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '')

const tabLabel = page => page.title || shortAddress(page.url) || t('New tab')

// The `+` popover anchored to its button. `items` holds {key, icon, label,
// onPick} and {sep:true} entries; Escape or a click outside closes it. The
// callers hide the button when the list is empty.
export function PanelMenu({ items, className, 'aria-label': label, icon: TriggerIcon = PlusTabIcon }) {
  const [open, setOpen] = useState(false)
  const [shown, leaving] = useLinger(open, 120)
  const wrap = useRef(null)
  const button = useRef(null)
  const pop = useRef(null)
  useEscape(() => { setOpen(false); button.current?.focus() }, open, { priority: ESCAPE_PRIORITY.MENU })
  useLayoutEffect(() => {
    const el = wrap.current
    const menu = pop.current
    if (!open || !el || !menu?.style) return
    const rect = el.getBoundingClientRect?.()
    if (!rect) return
    const panel = el.closest?.('.bt-panel')?.getBoundingClientRect?.()
    const leftBound = panel ? panel.left : 0
    const rightBound = panel ? panel.right : (typeof window === 'undefined' ? rect.right : window.innerWidth)
    const menuWidth = menu.offsetWidth || 184
    const pad = 8
    const minLeft = leftBound + pad
    const maxLeft = Math.max(minLeft, rightBound - pad - menuWidth)
    const spaceLeft = rect.right - leftBound
    const spaceRight = rightBound - rect.left
    const preferredLeft = spaceLeft < menuWidth + pad && spaceRight >= menuWidth + pad
      ? rect.left
      : rect.right - menuWidth
    const targetLeft = Math.max(minLeft, Math.min(preferredLeft, maxLeft))
    const rightOffset = Math.round(rect.right - (targetLeft + menuWidth))
    menu.style.right = rightOffset === 0 ? '' : `${rightOffset}px`
    const originX = Math.round(Math.max(12, Math.min(menuWidth - 12, (rect.left + rect.right) / 2 - targetLeft)))
    menu.style.transformOrigin = `${originX}px top`
  }, [open, shown])
  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => { if (wrap.current && !wrap.current.contains(event.target)) setOpen(false) }
    const onKey = (event) => { stepMenuFocus(wrap.current, event, button.current) }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onKey) }
  }, [open])
  if (items.length === 0) return null
  return h('span', { className: 'bt-pmenu', ref: wrap },
    h('button', {
      ref: button, type: 'button', className, 'aria-label': label, title: label,
      'aria-haspopup': 'menu', 'aria-expanded': open, onClick: () => setOpen(value => !value),
    }, h(TriggerIcon)),
    shown ? h('div', { ref: pop, className: 'bt-pmenu-pop', role: 'menu', 'data-leaving': leaving || undefined },
      items.map((item, index) => (item.sep
        ? h('span', { key: `sep-${index}`, className: 'bt-pmenu-sep', role: 'separator' })
        : h('button', {
          key: item.key, type: 'button', role: 'menuitem', className: 'bt-pmenu-item',
          onClick: () => { setOpen(false); item.onPick() },
        }, h(item.icon), h('span', null, item.label))))) : null)
}

// The menu builders in side-model.js give keys; each maps to an icon, a label
// and the action it runs. A rejected action surfaces through reportError.
export function menuItemFor(key, actions, subject) {
  const report = run => () => { void Promise.resolve(run()).catch(error => actions.reportError(error, 'panel-menu')) }
  switch (key) {
    case 'browser': return { key, icon: GlobeIcon, label: t('Browser'), onPick: report(() => actions.openBrowser(subject)) }
    case 'new-tab': return { key, icon: PlusTabIcon, label: t('New browser tab'), onPick: report(() => actions.browserNewTab(subject)) }
    case 'side': return { key, icon: SideIcon, label: t('Side chat'), onPick: report(() => actions.newSideChat(subject)) }
    case 'terminal': return { key, icon: TerminalIcon, label: t('Terminal'), onPick: report(() => actions.newTerminal()) }
    case 'files': return { key, icon: FolderIcon, label: t('Files'), onPick: report(() => actions.openFiles()) }
    default: return { sep: true }
  }
}

// A side chat tab names itself after its first question.
const sideTitle = chat => chat?.entries?.[0]?.question?.trim() || t('Side chat')

// The strip across the panel's top: the Bot's own tab first (the details view,
// collapsed), then browser pages, side chats, task reader, and workspace tabs,
// followed by browser-style `+` and right-pinned close.
const syncStripOverflow = (box) => {
  if (!box?.dataset) return
  const maxScroll = Math.max(0, (box.scrollWidth ?? 0) - (box.clientWidth ?? 0))
  const left = box.scrollLeft ?? 0
  if (maxScroll > 1 && left > 1) box.dataset.overflowLeft = ''
  else delete box.dataset.overflowLeft
  if (maxScroll > 1 && left < maxScroll - 1) box.dataset.overflowRight = ''
  else delete box.dataset.overflowRight
}
const measureTabSpot = (box, node, isStickyBot) => {
  const left = isStickyBot ? 0 : node.offsetLeft
  return { left, right: box.offsetWidth - left - node.offsetWidth, boxWidth: box.offsetWidth }
}

export function PanelStrip({ bot, roomSubject, subject, browserOwner, view, ids, active, sides, side, task, workspace, hasSubjectDetails = true, canBrowse, reading, onView, actions, useBrowserPages }) {
  const browserId = browserOwner ?? bot?.id ?? subject
  const pages = useBrowserPages(map => map)
  const wsTabs = workspace?.tabs ?? []
  const wsActive = workspace?.active ?? null
  const wrap = useRef(null)
  const ind = useRef(null)
  const spot = useRef(null)
  const under = useRef(null)
  const isStickyBot = useRef(false)
  const watcher = useRef(null)
  const observed = useRef(new Set())
  const stripKey = [
    hasSubjectDetails ? (bot?.name ?? roomSubject?.name ?? '') : '',
    ids.map(tabId => `${tabId}:${tabLabel(pages[tabId] ?? EMPTY_PAGE)}`).join('\0'),
    sides.map(chat => `${chat.id}:${sideTitle(chat)}`).join('\0'),
    task ? `${task.id}:${task.title}` : '',
    wsTabs.map(tab => `${tab.id}:${tab.label}`).join('\0'),
  ].join('\u0001')
  const syncObserved = () => {
    const observer = watcher.current
    const box = wrap.current
    if (!observer || !box) return
    const next = new Set(box.querySelectorAll('.bt-ptab-bot, .bt-ptab-wrap'))
    for (const el of observed.current) {
      if (!next.has(el)) { observer.unobserve(el); observed.current.delete(el) }
    }
    for (const el of next) {
      if (!observed.current.has(el)) { observer.observe(el); observed.current.add(el) }
    }
  }
  // The capsule sits under the active tab; its two edges move on different springs.
  useLayoutEffect(() => {
    const box = wrap.current
    const capsule = ind.current
    if (!box || !capsule) return undefined
    const node = view === 'details'
      ? box.querySelector('.bt-ptab-bot')
      : view === 'side'
        ? box.querySelector(`[data-side="${attrValue(side)}"]`)
        : view === 'task' && task
          ? box.querySelector(`[data-task="${attrValue(task.id)}"]`)
          : view === 'workspace' && wsActive !== null
            ? box.querySelector(`[data-ws-tab="${attrValue(wsActive)}"]`)
            : box.querySelector(`[data-tab="${attrValue(active)}"]`)
    const sticky = view === 'details' && node !== null
    under.current = node
    isStickyBot.current = sticky
    syncObserved()
    if (!node) {
      capsule.style.opacity = '0'
      spot.current = null
      syncStripOverflow(box)
      return undefined
    }
    // The Bot tab is pinned at the strip's start; showing it scrolls the pages back
    // so the capsule and the pinned tab line up.
    if (view === 'details') box.scrollLeft = 0
    else node.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    syncStripOverflow(box)
    const to = measureTabSpot(box, node, sticky)
    const rawFrom = spot.current
    const from = rawFrom === null
      ? null
      : { left: rawFrom.left, right: rawFrom.right + (to.boxWidth - rawFrom.boxWidth) }
    spot.current = to
    capsule.style.opacity = sticky && (box.scrollLeft ?? 0) > 0 ? '0' : '1'
    capsule.style.left = `${to.left}px`
    capsule.style.right = `${to.right}px`
    if (from === null || (from.left === to.left && from.right === to.right) || reducedMotion()) return undefined
    const ahead = to.left > from.left ? 'right' : 'left'
    const behind = ahead === 'right' ? 'left' : 'right'
    const lead = capsule.animate([{ [ahead]: `${from[ahead]}px` }, { [ahead]: `${to[ahead]}px` }], { duration: SPRING_LEAD.duration, easing: SPRING_LEAD.easing })
    const trail = capsule.animate([{ [behind]: `${from[behind]}px` }, { [behind]: `${to[behind]}px` }], { duration: SPRING_TRAIL.duration, easing: SPRING_TRAIL.easing })
    return () => { lead.cancel(); trail.cancel() }
  }, [view, active, side, wsActive, stripKey])
  // A drag resizes the strip without a render; sibling tab widths can change too
  // (e.g. a title or font loading), shifting the active tab's offsetLeft.
  // Vertical wheel input over an overflowing strip also scrolls it horizontally.
  useEffect(() => {
    const box = wrap.current
    if (!box) return undefined
    const observer = new ResizeObserver(() => {
      syncStripOverflow(box)
      const node = under.current
      const capsule = ind.current
      if (!node?.isConnected || !capsule || spot.current === null) return
      spot.current = measureTabSpot(box, node, isStickyBot.current)
      capsule.style.left = `${spot.current.left}px`
      capsule.style.right = `${spot.current.right}px`
      if (isStickyBot.current) capsule.style.opacity = (box.scrollLeft ?? 0) > 0 ? '0' : '1'
    })
    const onScroll = () => {
      syncStripOverflow(box)
      if (isStickyBot.current && ind.current) {
        ind.current.style.opacity = (box.scrollLeft ?? 0) > 0 ? '0' : '1'
      }
    }
    const onWheel = (event) => {
      if ((box.scrollWidth ?? 0) <= (box.clientWidth ?? 0)) return
      if (event.deltaY === 0 || Math.abs(event.deltaY) < Math.abs(event.deltaX)) return
      const dy = event.deltaMode === 1
        ? event.deltaY * 24
        : event.deltaMode === 2
          ? event.deltaY * box.clientWidth
          : event.deltaY
      if (dy === 0) return
      event.preventDefault()
      box.scrollLeft += dy
      syncStripOverflow(box)
    }
    watcher.current = observer
    observer.observe(box)
    syncObserved()
    syncStripOverflow(box)
    box.addEventListener?.('scroll', onScroll, { passive: true })
    box.addEventListener?.('wheel', onWheel, { passive: false })
    return () => {
      watcher.current = null
      observed.current.clear()
      observer.disconnect()
      box.removeEventListener?.('scroll', onScroll)
      box.removeEventListener?.('wheel', onWheel)
    }
  }, [])
  const items = stripMenuKeys({
    canBrowse,
    canSide: Boolean(bot),
    canTerminal: actions.canOpenTerminal?.() === true,
    canFiles: actions.canOpenFiles?.() === true,
  }).map(key => menuItemFor(key, actions, key === 'browser' || key === 'new-tab' ? browserId : subject))
  // `data-window-drag` is the shell's window drag-row mark on macOS: base.css turns it
  // into the drag geometry, and the shell's watcher re-collects that geometry while the
  // panel slides in. The rule in styles.js declares the same row for a shell without it.
  return h('div', { className: 'bt-ptabs', role: 'tablist', 'data-window-drag': true, 'aria-label': t('Panel tabs') },
    h('div', { className: 'bt-ptabs-in', ref: wrap },
      hasSubjectDetails ? h('button', {
        type: 'button', role: 'tab', 'aria-selected': view === 'details', className: 'bt-ptab bt-ptab-bot',
        title: bot?.name ?? roomSubject?.name ?? t('Details'), onClick: () => onView('details'),
      },
        bot ? h(BotMark, { bot, size: 20, state: reading ? 'searching' : 'idle' }) : null,
        view === 'details' || !bot ? h('span', { className: 'bt-ptab-name' }, bot?.name ?? roomSubject?.name ?? t('Details')) : null) : null,
      ids.map((tabId) => {
        const page = pages[tabId] ?? EMPTY_PAGE
        const on = view === 'browser' && tabId === active
        return h('div', {
          key: tabId, role: 'presentation', 'data-tab': tabId, 'data-selected': on || undefined, className: 'bt-ptab-wrap',
        },
          h('button', {
            type: 'button', role: 'tab', 'aria-selected': on, className: 'bt-ptab bt-ptab-btn',
            title: visibleUrl(page.url) || t('New tab'),
            onClick: () => { actions.browserActivate(browserId, tabId); onView('browser') },
            onAuxClick: (event) => { if (event.button === 1) { event.preventDefault(); void actions.browserCloseTab(browserId, tabId) } },
          },
            h(Favicon, { src: page.favicon, className: 'bt-ptab-fav' }),
            h('span', { className: 'bt-ptab-title' }, tabLabel(page))),
          h('button', {
            type: 'button', className: 'bt-ptab-x', 'aria-label': t('Close tab'), title: t('Close tab'),
            onClick: () => { void actions.browserCloseTab(browserId, tabId) },
          }, '×'))
      }),
      sides.map((chat) => {
        const on = view === 'side' && chat.id === side
        return h('div', {
          key: chat.id, role: 'presentation', 'data-side': chat.id, 'data-selected': on || undefined, className: 'bt-ptab-wrap bt-ptab-side',
        },
          h('button', {
            type: 'button', role: 'tab', 'aria-selected': on, className: 'bt-ptab bt-ptab-btn',
            title: sideTitle(chat),
            onClick: () => actions.openSideChat(subject, chat.id),
            onAuxClick: (event) => { if (event.button === 1) { event.preventDefault(); void actions.closeSideChat(chat.id) } },
          },
            h('span', { className: 'bt-ptab-globe', 'aria-hidden': true }, h(SideIcon)),
            h('span', { className: 'bt-ptab-title' }, sideTitle(chat))),
          h('button', {
            type: 'button', className: 'bt-ptab-x', 'aria-label': t('Close side chat'), title: t('Close side chat'),
            onClick: () => { void actions.closeSideChat(chat.id) },
          }, '×'))
      }),
      task
        ? h('div', {
            key: `task:${task.id}`, role: 'presentation', 'data-task': task.id, 'data-selected': view === 'task' || undefined, className: 'bt-ptab-wrap bt-ptab-side',
          },
          h('button', {
            type: 'button', role: 'tab', 'aria-selected': view === 'task', className: 'bt-ptab bt-ptab-btn',
            title: task.title,
            onClick: () => onView('task'),
            onAuxClick: (event) => { if (event.button === 1) { event.preventDefault(); actions.closeTask?.() } },
          },
            h('span', { className: 'bt-task-dot', 'data-status': task.status, 'aria-hidden': true }),
            h('span', { className: 'bt-ptab-title' }, task.title)),
          h('button', {
            type: 'button', className: 'bt-ptab-x', 'aria-label': t('Close'), title: t('Close'),
            onClick: () => { actions.closeTask?.() },
          }, '×'))
        : null,
      wsTabs.map((tab) => {
        const on = view === 'workspace' && tab.id === wsActive
        const closable = tab.closable !== false
        return h('div', {
          key: `ws:${tab.id}`, role: 'presentation', 'data-ws-tab': tab.id, 'data-selected': on || undefined,
          className: closable ? 'bt-ptab-wrap bt-ptab-ws' : 'bt-ptab-wrap bt-ptab-ws bt-ptab-fixed',
        },
          h('button', {
            type: 'button', role: 'tab', 'aria-selected': on, className: 'bt-ptab bt-ptab-btn',
            title: tab.label,
            onClick: () => {
              if (view !== 'workspace') onView('workspace')
              workspace.onSelect?.(tab.id)
            },
            onAuxClick: closable
              ? (event) => { if (event.button === 1) { event.preventDefault(); workspace.onCloseTab?.(tab.id) } }
              : undefined,
          },
            tab.icon ? h('span', { className: 'bt-ptab-globe', 'aria-hidden': true }, h(tab.icon)) : null,
            h('span', { className: 'bt-ptab-title' }, tab.label)),
          closable
            ? h('button', {
                type: 'button', className: 'bt-ptab-x', 'aria-label': t('Close tab'), title: t('Close tab'),
                onClick: () => { workspace.onCloseTab?.(tab.id) },
              }, '×')
            : null)
      }),
      h('span', { ref: ind, className: 'bt-ptab-ind', 'aria-hidden': true })),
    // `+` sits right after the tabs (and pins before Close on overflow); Close stays right-aligned.
    items.length > 0 ? h(PanelMenu, { items, className: 'bt-ptab-new', 'aria-label': t('New tab') }) : null,
    h('button', { type: 'button', className: 'bt-icon-btn bt-ptab-close', 'aria-label': t('Close panel'), title: t('Close panel'), onClick: () => actions.closePanel() }, h(CloseIcon)))
}

const OVERLAY_SELECTOR = '[role="dialog"],[role="menu"],[role="listbox"]'
const isElementNode = node => node !== null && typeof node === 'object' && node.nodeType === 1
function hasOverlayNode(nodes) {
  if (!nodes) return false
  for (const node of nodes) {
    if (isElementNode(node) && (node.matches?.(OVERLAY_SELECTOR) || node.querySelector?.(OVERLAY_SELECTOR) != null)) {
      return true
    }
  }
  return false
}
export function shouldCheckBrowserCover(records) {
  return records.some((record) => {
    if (record.type === 'attributes') {
      if (record.attributeName === 'role') return true
      const target = record.target
      return isElementNode(target) && (target.matches?.(OVERLAY_SELECTOR) || target.closest?.(OVERLAY_SELECTOR) != null || target.querySelector?.(OVERLAY_SELECTOR) != null)
    }
    if (!isElementNode(record.target)) return false
    if (record.target.closest?.(OVERLAY_SELECTOR)) return true
    return hasOverlayNode(record.addedNodes) || hasOverlayNode(record.removedNodes)
  })
}

// The browser view: toolbar (back, forward, reload/stop, address) over the frame
// the guest webview covers.
export function BrowserView({ bot, ownerId, tabId, leaving, landed, actions, useBrowserPages, hold }) {
  const browserId = ownerId ?? bot?.id ?? ''
  const page = useBrowserPages(pages => pages[tabId ?? '']) ?? EMPTY_PAGE
  const pageUrl = visibleUrl(page.url)
  const frame = useRef(null)
  const input = useRef(null)
  const importBoxRef = useRef(null)
  const [draft, setDraft] = useState(null)
  const [covered, setCovered] = useState(false)

  // Cookie imports (the desktop app's bridge only, Bot browser only): 'menu' lists browser profiles first,
  // then file/paste; a card stage runs connecting / remote-debug / running / paste →
  // preview → result | error above the guest.
  const imports = bot ? actions.browserImport : undefined
  const {
    flow, sources, loadingSources, lastSourceId, busy, setFlowTracked,
    openImport, pickFile, openPaste, submitPaste, pickSource, closeAndImport,
    applyImport, cancelImport, doneImport, retrySource, launchSource, openPermission,
  } = useCookieImportFlow({
    imports,
    botId: bot?.id ?? '',
    pageUrl,
    resetKey: tabId,
    idleFlow: null,
    onReload: () => actions.browserCommand(tabId, 'reload'),
  })
  const importStageKey = flow === null ? null : flow === 'menu' ? 'menu' : flow.stage
  useMorph(importBoxRef, importStageKey)

  // The guest goes on screen once the panel has landed and settled on its width,
  // and only over a page: the empty, error and import states are the panel's own.
  const showGuest = landed && !leaving && !covered && Boolean(pageUrl) && !page.error && flow === null

  useEffect(() => {
    let raf = 0
    const update = () => {
      raf = 0
      const panel = frame.current?.getBoundingClientRect()
      const overlaps = panel && [...document.querySelectorAll(OVERLAY_SELECTOR)]
        .some(element => rectsOverlap(panel, element.getBoundingClientRect()))
      setCovered(Boolean(overlaps))
    }
    const schedule = () => { if (!raf) raf = requestAnimationFrame(update) }
    const observer = new MutationObserver((records) => {
      if (shouldCheckBrowserCover(records)) schedule()
    })
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['role', 'data-leaving'] })
    window.addEventListener('resize', schedule)
    update()
    return () => { cancelAnimationFrame(raf); observer.disconnect(); window.removeEventListener('resize', schedule) }
  }, [])

  useLayoutEffect(() => {
    const element = frame.current
    if (!element || leaving || !tabId) { void actions.browserShow(null); return undefined }
    let raf = 0
    const measure = () => {
      cancelAnimationFrame(raf)
      raf = 0
      const box = element.getBoundingClientRect()
      void actions.browserShow(tabId, showGuest ? { left: box.left, top: box.top, width: box.width, height: box.height } : null)
    }
    const schedule = () => { if (!raf) raf = requestAnimationFrame(measure) }
    measure()
    // Measured inside the observer callback, where layout is fresh: the guest moves in
    // the same frame as the panel edge instead of one behind it.
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    window.addEventListener('resize', schedule)
    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      window.removeEventListener('resize', schedule)
    }
  }, [tabId, showGuest, leaving])

  // A fresh tab starts on its address bar.
  useEffect(() => {
    setDraft(null)
    if (landed && !pageUrl) input.current?.focus()
  }, [tabId, landed])

  const go = (event) => {
    event.preventDefault()
    const text = draft ?? ''
    if (text.trim() === '') return
    setDraft(null)
    input.current?.blur()
    void actions.browserNavigate(tabId, text).then((opened) => { if (opened) actions.browserFocus(tabId) })
  }

  const editing = draft !== null
  useEscape(() => { setDraft(null); input.current?.blur() }, editing, { priority: ESCAPE_PRIORITY.INLINE_ACTION })
  const secure = /^https:/i.test(pageUrl)
  const viewLabel = bot ? t("{name}'s browser", { name: bot.name }) : t('Browser')
  return h('div', { className: 'bt-panel-view bt-panel-browser', 'aria-label': viewLabel },
    bot && actions.browserTakeover ? h('div', { className: 'bt-browser-takeover', 'data-held': hold?.by === 'user' || undefined },
      h('span', null, hold?.by === 'user' ? t('You control this browser') : hold?.by === 'bot' ? t('The Bot handed this browser to you: {reason}', { reason: hold.reason }) : t('The Bot controls this browser')),
      hold?.by
        ? h('button', { type: 'button', onClick: () => void actions.browserGiveBack(bot.id) }, t('Give back'))
        : h('span', { className: 'bt-browser-takeover-actions' },
            h('button', { type: 'button', onClick: () => void actions.browserTakeover(bot.id) }, t('Take over')),
            h('button', { type: 'button', onClick: () => void actions.browserStop(bot.id) }, t('Stop')))) : null,
    h('div', { className: 'bt-browser-bar' },
      h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Back'), title: t('Back'), disabled: !page.canGoBack, onClick: () => actions.browserCommand(tabId, 'back') }, h(BackIcon)),
      h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Forward'), title: t('Forward'), disabled: !page.canGoForward, onClick: () => actions.browserCommand(tabId, 'forward') }, h(ForwardIcon)),
      h('button', {
        type: 'button', className: 'bt-icon-btn', disabled: !pageUrl,
        'aria-label': page.loading ? t('Stop') : t('Reload'), title: page.loading ? t('Stop') : t('Reload'),
        onClick: () => actions.browserCommand(tabId, page.loading ? 'stop' : 'reload'),
      }, h(page.loading ? StopIcon : ReloadIcon)),
      h('form', { className: 'bt-browser-address', onSubmit: go, 'data-editing': editing || undefined },
        h('span', { className: 'bt-browser-scheme', 'aria-hidden': true }, h(secure && !editing ? LockIcon : GlobeIcon)),
        h('input', {
          ref: input, type: 'text', spellCheck: false, autoComplete: 'off', 'aria-label': t('Address'),
          placeholder: t('Search or enter address'),
          value: editing ? draft : shortAddress(pageUrl),
          onFocus: (event) => { setDraft(pageUrl); const target = event.target; requestAnimationFrame(() => target.select()) },
          onBlur: () => setDraft(null),
          onChange: event => setDraft(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Escape' && !event.nativeEvent?.isComposing && event.keyCode !== 229) {
              if (event.defaultPrevented || topEscapePriority() > ESCAPE_PRIORITY.INLINE_ACTION) return
              event.preventDefault?.()
              event.stopPropagation?.()
              event.nativeEvent?.stopPropagation?.()
              setDraft(null)
              event.currentTarget.blur()
            }
          },
        })),
      h('button', {
        type: 'button', className: 'bt-icon-btn', 'aria-label': t('New browser tab'), title: t('New browser tab'),
        onClick: () => actions.browserNewTab(browserId),
      }, h(PlusTabIcon)),
      imports ? h('button', {
        type: 'button', className: 'bt-icon-btn bt-import-btn', 'aria-label': t('Import cookies'), title: t('Import cookies'),
        'aria-expanded': flow !== null, 'data-open': flow !== null || undefined, disabled: busy,
        onClick: () => { if (flow !== null) cancelImport(); else openImport() },
      }, h(ImportIcon)) : null,
      page.loading ? h('span', { className: 'bt-browser-progress', 'aria-hidden': true }) : null),
    h('div', { ref: frame, className: 'bt-browser-frame', 'data-guest': showGuest || undefined },
      flow !== null ? h('div', {
        className: 'bt-import-card',
        onClick: (event) => {
          if (event.target !== event.currentTarget || busy) return
          if (typeof flow === 'object' && flow.stage === 'result') setFlowTracked(null)
          else cancelImport()
        },
      },
        h('div', { ref: importBoxRef, className: 'bt-import-box', 'data-stage': importStageKey },
          flow === 'menu'
            ? h(ImportMenu, {
              sources,
              lastSourceId,
              loading: loadingSources,
              busy,
              canPaste: Boolean(imports?.paste),
              onFile: pickFile,
              onPaste: openPaste,
              onSource: pickSource,
              onClose: cancelImport,
            })
            : h(ImportCard, {
              flow,
              page,
              busy,
              imports,
              onApply: applyImport,
              onCancel: cancelImport,
              onBack: openImport,
              onCloseAndImport: closeAndImport,
              onRetrySource: retrySource,
              onLaunchSource: launchSource,
              onOpenPermission: openPermission,
              onFile: pickFile,
              onSubmitPaste: submitPaste,
              onDone: doneImport,
              onReload: () => actions.browserCommand(tabId, 'reload'),
            }))) : null,
      flow === null && page.error
        ? h('div', { className: 'bt-browser-empty' },
            h('div', { className: 'bt-browser-empty-title' }, t('This page didn’t load')),
            h('div', { className: 'bt-browser-empty-text' }, t(page.error)),
            pageUrl ? h('button', { type: 'button', className: 'bt-browser-retry', onClick: () => { void actions.browserNavigate(tabId, pageUrl) } }, t('Try again')) : null)
        : flow === null && !pageUrl
          ? h('div', { className: 'bt-browser-empty' },
              bot
                ? h(BotMark, { bot, size: 48, state: 'idle', live: true })
                : h('span', { className: 'bt-browser-empty-icon', 'aria-hidden': true }, h(GlobeIcon)),
              h('div', { className: 'bt-browser-empty-title' }, bot ? t("{name}'s browser", { name: bot.name }) : t('Browser')),
              h('div', { className: 'bt-browser-empty-text' }, bot
                ? t('Open a page here and {name} can read it with you. Logins and cookies stay with {name}; other Bots never see them.', { name: bot.name })
                : t('Open a page beside your session. Enter an address above to get started.')),
              bot && imports ? h('button', { type: 'button', className: 'bt-browser-retry', onClick: openImport }, t('Import cookies')) : null)
          : null))
}


/**
 * One aside for the Bot's details, browser, side chats, task viewer, and optional
 * workspace tabs. `pane` is `{ id, view: 'details'|'browser'|'side'|'task'|'workspace', renaming, tab, side, task }`;
 * `id` is the Session id the panel follows and `side` the open chat's id. Without the
 * Desktop bridge the browser view never shows; side chats need no bridge.
 */
export function BotPanel({ pane, leaving, room, overlay, roster, actions, useSessions, useSessionStatus, useActivity, useWork, useBrowserTabs, useBrowserPages, useBrowserHolds, useComputer, workspace }) {
  const bot = roster.byId[pane.id]
  const roomSubject = roster.roomsById?.[pane.id]
  const subjectId = bot?.id ?? roomSubject?.id ?? pane.id
  const hasSubjectDetails = Boolean(bot || roomSubject)
  const wsTabs = workspace?.tabs ?? []
  const hasWs = wsTabs.length > 0
  const activeWsTab = wsTabs.find(tab => tab.id === workspace?.active)
  const browserOwner = bot ? bot.id : (!hasSubjectDetails && workspace?.browserId ? workspace.browserId : null)
  const canBrowse = Boolean(browserOwner && roster.browser === true && actions.browserShow)
  const sideChats = bot ? sideChatsOf(roster, bot.id) : []
  const sideChat = sideChats.find(chat => chat?.id === pane.side)
  const taskBot = pane.task?.botId ? roster.byId?.[pane.task.botId] : undefined
  const taskEntry = taskBot && pane.task?.taskId ? (taskBot.tasks ?? []).find(item => item?.id === pane.task.taskId) : undefined
  const view = pane.view === 'browser' && canBrowse ? 'browser'
    : pane.view === 'side' && sideChat !== undefined ? 'side'
      : pane.view === 'task' && taskEntry !== undefined ? 'task'
        : pane.view === 'workspace' && (hasWs || leaving) ? 'workspace'
          : hasSubjectDetails ? 'details'
            : hasWs ? 'workspace'
              : 'details'
  const tabState = useBrowserTabs(map => (browserOwner ? (map[browserOwner] ?? EMPTY_TABS) : EMPTY_TABS))
  const active = tabState.active
  const page = useBrowserPages(pages => (active ? pages[active] : null) ?? EMPTY_PAGE)
  const hold = useBrowserHolds?.(map => bot ? map[bot.id] ?? null : null) ?? null
  const root = useRef(null)
  // The Bot's mark flying between the drawer and the strip, and the note a switch leaves
  // for the commit that follows it (what to fly, from where).
  const [flight] = useState(() => createFlight({ shape: SPRING_SHAPE }))
  const intent = useRef(null)
  const [landed, setLanded] = useState(false)
  const [settling, setSettling] = useState(false)
  const [width, setWidth] = useState(savedWidth)
  // While dragging or while the window resizes, width changes land at once.
  const [dragging, setDragging] = useState(false)
  const [resizing, setResizing] = useState(false)
  const instant = dragging || resizing
  const [reading, setReading] = useState(false)

  const defaultWidth = view === 'browser' ? DEFAULT_WIDTH : view === 'workspace' ? DEFAULT_WORKSPACE_WIDTH : DETAILS_WIDTH
  const panelWidth = fitWidth(width ?? defaultWidth, widthRange(view, room))
  // Once the browser or workspace has shown, the Bot page keeps its width (up to DETAILS_MAX).
  useLayoutEffect(() => {
    if (width !== null) return
    if (view === 'browser') setWidth(DEFAULT_WIDTH)
    else if (view === 'workspace') setWidth(DEFAULT_WORKSPACE_WIDTH)
  }, [view, width])
  useLayoutEffect(() => { chatRoom.hold(instant) }, [instant])
  // A view switch that changes the width holds the guest back and pins both views to
  // the final width until the panel edge has settled. It is set while rendering, so the
  // switch's own commit is already pinned and the flying mark measures where its target
  // ends up, not where it sits before the pin.
  const [last, setLast] = useState({ view, width: panelWidth })
  if (last.view !== view || last.width !== panelWidth) {
    setLast({ view, width: panelWidth })
    // An overlay panel covers the window whatever its width variable says: nothing settles.
    if (last.view !== view) setSettling(last.width !== panelWidth && !instant && !overlay)
  }
  // Such a switch gives the conversation its new width at once, so it reflows once
  // instead of every frame of the glide. Opening and closing glide it with the panel.
  const shownView = useRef(view)
  useLayoutEffect(() => {
    const switched = settling && shownView.current !== view
    shownView.current = view
    if (switched) chatRoom.hold(true)
    chatRoom.setRight(leaving || overlay ? null : panelWidth)
    if (switched) chatRoom.hold(false)
  }, [view, panelWidth, leaving, overlay])
  const dragCleanup = useRef(null)
  useEscape(() => actions.closeOverlay(), !leaving, { priority: ESCAPE_PRIORITY.PANEL })
  useEffect(() => () => { dragCleanup.current?.(); chatRoom.setRight(null); chatRoom.hold(false) }, [])
  // A `room` change (window resize, the left column moving) lands at once.
  const mounted = useRef(false)
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return undefined }
    setResizing(true)
    const timer = setTimeout(() => setResizing(false), 160)
    return () => clearTimeout(timer)
  }, [room])
  useEffect(() => {
    if (!settling) return undefined
    const timer = setTimeout(() => setSettling(false), SPRING_SHAPE.duration + 40)
    return () => clearTimeout(timer)
  }, [settling, view])
  useEffect(() => {
    const timer = setTimeout(() => setLanded(true), 360)
    return () => clearTimeout(timer)
  }, [])

  // A Bot's (or Classic session's) browser strip restores as soon as the panel opens for it.
  useEffect(() => { if (canBrowse && browserOwner) actions.browserEnsure(browserOwner) }, [browserOwner, canBrowse])
  // With the last tab closed the browser view folds back into workspace (if open), details, or closes.
  useEffect(() => {
    if (view === 'browser' && (active === null || !tabState.ids.includes(active))) {
      if (workspace !== undefined && hasWs) actions.setPanelView('workspace')
      else if (hasSubjectDetails) actions.setPanelView('details')
      else actions.closePanel?.()
    }
  }, [view, active, tabState.ids.length, workspace, hasWs, hasSubjectDetails])
  // A side chat closed here or in another window folds back into details too.
  useEffect(() => {
    if (pane.view === 'side' && sideChat === undefined) actions.setPanelView('details')
  }, [pane.view, sideChat])
  useEffect(() => {
    if (pane.view === 'task' && taskEntry === undefined) actions.closeTask?.()
  }, [pane.view, taskEntry])
  // In standalone desktop mode, close the panel if subject details, workspace tabs, and
  // browser tabs are all gone, or fold workspace back to details/browser when workspace tabs clear.
  useEffect(() => {
    if (leaving) return
    const hasBrowser = canBrowse && (pane.view === 'browser' || tabState.ids.length > 0)
    if (workspace !== undefined && !hasSubjectDetails && !hasWs && !hasBrowser) {
      actions.closePanel?.()
      return
    }
    if (pane.view !== 'workspace' || hasWs) return
    if (canBrowse && tabState.ids.length > 0) actions.setPanelView('browser')
    else if (hasSubjectDetails) actions.setPanelView('details')
    else actions.closePanel?.()
  }, [leaving, workspace, pane.view, hasWs, hasSubjectDetails, canBrowse, tabState.ids.length])
  // The guest leaves the screen while the details view is up, and on close.
  useEffect(() => {
    if (view !== 'browser' || leaving) void actions.browserShow?.(null)
  }, [view, leaving])
  useEffect(() => () => { void actions.browserShow?.(null) }, [])

  useEffect(() => {
    if (!page.readAt || Date.now() - page.readAt > READ_FLASH_MS) return undefined
    setReading(true)
    const timer = setTimeout(() => setReading(false), READ_FLASH_MS)
    return () => clearTimeout(timer)
  }, [page.readAt])

  // A view switch flies the Bot's mark between the drawer avatar and the strip, and the
  // outgoing view fades out over the incoming one at its own width. This runs before the
  // view changes and leaves a note; the layout effect below takes it up once the new
  // view stands, because only then is there a target to fly to.
  const beginSwitch = (next) => {
    const panel = root.current
    intent.current = null
    if (reducedMotion()) { flight.finish(); return }
    if (!panel) return
    // The mark flies between the drawer avatar (details view) and the strip's Bot tab:
    // up into the tab when the details view is left, back down when it returns. A switch
    // between the browser and a side chat has no drawer avatar and nothing to fly.
    const plan = planFlight(flight.active(), next)
    const source = plan === 'start' ? panel.querySelector(FLIGHT_ENDS[flightStart(next)]) : null
    const flies = plan !== 'keep' && (plan === 'reverse' || source !== null)
    const outgoing = panel.querySelector(':scope > .bt-panel-view:not([hidden])')
    if (outgoing) {
      const ghostEl = document.createElement('div')
      ghostEl.className = 'bt-panel-ghost'
      // The fading copy stays exactly where the view stood, whatever the panel grows around it.
      Object.assign(ghostEl.style, { top: `${outgoing.offsetTop}px`, width: `${outgoing.offsetWidth}px`, height: `${outgoing.offsetHeight}px` })
      ghostEl.append(uniqueIds(outgoing.cloneNode(true)))
      // The flying mark stands in for the drawer's; the fading copy must not show it a second time.
      if (flies && next !== 'details') for (const mark of ghostEl.querySelectorAll('.bt-drawer-id .bt-mark')) mark.style.visibility = 'hidden'
      panel.append(ghostEl)
      void ghostEl.animate([
        { opacity: 1, transform: 'scale(1)' },
        { opacity: 0, transform: 'scale(0.985)' },
      ], { duration: 160, easing: 'ease-out', fill: 'forwards' }).finished.catch(() => {}).finally(() => ghostEl.remove())
    }
    if (plan === 'start' && source === null) return
    intent.current = {
      plan, next, id: subjectId, at: performance.now(), end: flightEnd(next),
      node: source ? uniqueIds(source.cloneNode(true)) : null, from: source ? source.getBoundingClientRect() : null,
    }
  }
  const switchView = (next) => {
    if (next === view || leaving) return
    beginSwitch(next)
    actions.setPanelView(next)
  }
  // Every path into the browser view (globe, card, +) animates the same collapse.
  const viewRef = useRef(view)
  viewRef.current = view
  const beginSwitchRef = useRef(beginSwitch)
  beginSwitchRef.current = beginSwitch
  const panelActions = useMemo(() => {
    const next = { ...actions }
    for (const name of ['openBrowser', 'browserNewTab', 'browserPick']) {
      if (actions[name]) next[name] = (...args) => { if (viewRef.current !== 'browser') beginSwitchRef.current('browser'); return actions[name](...args) }
    }
    for (const name of ['openSideChat', 'newSideChat']) {
      if (actions[name]) next[name] = (...args) => { if (viewRef.current !== 'side') beginSwitchRef.current('side'); return actions[name](...args) }
    }
    for (const name of ['openFiles', 'openFile', 'openChanges', 'newTerminal']) {
      if (actions[name]) next[name] = (...args) => { if (viewRef.current !== 'workspace') beginSwitchRef.current('workspace'); return actions[name](...args) }
    }
    return next
  }, [actions])
  // The note is good for the one switch it was made for. A view change without a note
  // (a closed tab folding the panel back, say) or after the note went stale ends the flight:
  // its target is no longer what it flew for.
  useLayoutEffect(() => {
    const note = intent.current
    intent.current = null
    const current = note !== null && note.next === view && note.id === subjectId && performance.now() - note.at < INTENT_MS && !instant && !leaving && !reducedMotion()
    if (!current) { flight.finish(); return }
    if (note.plan === 'keep') return
    if (note.plan === 'reverse') { if (!flight.retarget(note.end)) flight.finish(); return }
    flight.begin({ panel: root.current, end: note.end, node: note.node, from: note.from })
  }, [view, subjectId])
  // A drag, a window resize, the panel leaving or going away end the flight on the spot:
  // the mark is back where it belongs and nothing of the copy stays.
  useLayoutEffect(() => { if (instant || leaving) flight.finish() }, [instant, leaving])
  useEffect(() => flight.finish, [])

  // A drag writes the width into the panel's and the column's own inline styles each
  // frame (each restyles one element) and renders once, on release.
  const startResize = (event) => {
    if (event.button !== 0 || leaving || overlay) return
    event.preventDefault()
    const panel = root.current
    const grip = event.currentTarget
    grip.setPointerCapture?.(event.pointerId)
    const range = widthRange(view, room)
    const from = { x: event.clientX, width: panelWidth }
    let next = panelWidth
    setDragging(true)
    setSettling(false)
    chatRoom.hold(true)
    const columns = chatRoom.columns()
    for (const column of columns) column.style.setProperty('transition', 'none', 'important')
    const onMove = (move) => {
      next = fitWidth(from.width + from.x - move.clientX, range)
      panel.style.width = `${next}px`
      if (columns.length === 0) chatRoom.setRight(next)
      for (const column of columns) column.style.setProperty('margin-right', `${next}px`, 'important')
    }
    const ends = ['pointerup', 'pointercancel', 'lostpointercapture']
    const cleanup = () => {
      dragCleanup.current = null
      grip.removeEventListener('pointermove', onMove)
      for (const name of ends) grip.removeEventListener(name, onEnd)
      for (const column of columns) { column.style.removeProperty('margin-right'); column.style.removeProperty('transition') }
      panel?.style.removeProperty('width')
    }
    const onEnd = (end) => {
      if (end.type === 'pointerup') onMove(end)
      cleanup()
      // Hand the width back to the rule and the panel's variable in the same frame.
      chatRoom.setRight(next)
      panel?.style.setProperty('--bt-panel-w', `${next}px`)
      setDragging(false)
      if (next === from.width) return
      setWidth(next)
      try { localStorage.setItem(WIDTH_KEY, String(next)) } catch { /* storage unavailable */ }
    }
    dragCleanup.current = cleanup
    grip.addEventListener('pointermove', onMove)
    for (const name of ends) grip.addEventListener(name, onEnd)
  }

  const hasStrip = panelHasStrip(canBrowse, tabState.ids.length, sideChats.length, taskEntry !== undefined, wsTabs.length)
    || (workspace !== undefined && (!hasSubjectDetails || (leaving && (pane.view === 'workspace' || pane.view === 'browser'))))
  return h('aside', {
    ref: root, className: 'bt-panel', 'data-view': view,
    'aria-label': view === 'browser' ? (bot ? t("{name}'s browser", { name: bot.name }) : t('Browser'))
      : view === 'side' ? t('Side chat')
        : view === 'task' && taskEntry ? taskEntry.title
          : view === 'workspace' ? (activeWsTab?.label || t('Workspace'))
            : t('Conversation details'),
    'data-leaving': leaving || undefined, 'aria-hidden': leaving || undefined, 'data-settling': settling || undefined,
    'data-instant': instant || undefined, 'data-dragging': dragging || undefined, 'data-overlay': overlay || undefined, style: { '--bt-panel-w': `${panelWidth}px` },
    onAnimationEnd: (event) => { if (event.target === event.currentTarget) setLanded(true) },
  },
    leaving || overlay ? null : h('div', { className: 'bt-panel-grip', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': t('Resize panel'), onPointerDown: startResize }),
    // Over the whole window while dragging: the cursor stays a resize cursor and the
    // pages underneath (the chat, the guest) see no pointer.
    dragging ? createPortal(h('div', { className: 'bt-drag-shield', 'aria-hidden': true }), document.body) : null,
    hasStrip ? h(PanelStrip, {
      bot, roomSubject, subject: pane.id, browserOwner, view, ids: tabState.ids, active, sides: sideChats, side: pane.side, task: taskEntry,
      workspace, hasSubjectDetails: hasSubjectDetails || workspace === undefined,
      canBrowse, reading, onView: switchView, actions: panelActions, useBrowserPages,
    }) : null,
    hasWs
      ? h('div', { key: 'workspace', className: 'bt-panel-view bt-panel-workspace', hidden: view !== 'workspace' },
          workspace.render(workspace.active, view === 'workspace'))
      : null,
    view === 'workspace'
      ? (!hasWs ? h('div', { key: 'workspace-empty', className: 'bt-panel-view bt-panel-workspace' }) : null)
      : view === 'browser' && browserOwner
        ? h(BrowserView, { key: `browser:${active}`, bot, ownerId: browserOwner, tabId: active, leaving, landed: landed && !settling, actions, useBrowserPages, hold })
        : view === 'side' && sideChat
          ? h('div', { key: `side:${sideChat.id}`, className: 'bt-panel-view' }, h(SideChatView, { subject: pane.id, chat: sideChat, roster, actions: panelActions }))
          : view === 'task' && taskEntry && taskBot
            ? h('div', { key: `task:${taskEntry.id}`, className: 'bt-panel-view' }, h(TaskReaderView, { bot: taskBot, task: taskEntry, actions: panelActions }))
            : (hasSubjectDetails || workspace === undefined)
              ? h('div', { key: `details:${subjectId}:${pane.renaming ? 'rename' : ''}:${pane.tab ?? ''}`, className: 'bt-panel-view' },
                  h(DetailsDrawer, {
                    sessionId: pane.id, startRenaming: pane.renaming, startTab: pane.tab, hasStrip,
                    roster, actions: panelActions, useSessions, useSessionStatus, useActivity, useWork, useBrowserTabs, useBrowserPages, useBrowserHolds, useComputer,
                  }))
              : null)
}

export const BROWSER_CSS = `
.bt-panel{--bt-panel-view-fade:${SPRING_SHAPE.duration}ms}
.bt-ptabs{position:relative;display:flex;align-items:center;height:44px;flex:none;border-bottom:.5px solid var(--bt-line);padding:0 6px;gap:0;animation:bt-strip-in ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing}}
@keyframes bt-strip-in{from{height:0;opacity:0}}
.bt-ptabs-in{position:relative;display:flex;align-items:center;gap:2px;flex:0 1 auto;min-width:0;height:100%;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;padding:4px 2px 4px 0;scroll-padding-left:48px}
.bt-ptabs-in[data-overflow-right]{mask-image:linear-gradient(to right,#000,#000 calc(100% - 14px),transparent)}
.bt-ptabs-in>.bt-ptab-bot{position:sticky;left:0;z-index:2;background:var(--bt-main);box-shadow:-4px 0 0 6px var(--bt-main),6px 0 8px -2px var(--bt-main)}
.bt-ptabs-in>.bt-ptab-bot[aria-selected=true]{background:color-mix(in srgb,var(--bt-ink) 6%,var(--bt-main));box-shadow:-4px 0 0 6px var(--bt-main),6px 0 8px -2px var(--bt-main)}
.bt-ptabs-in::-webkit-scrollbar{display:none}
.bt-ptab-wrap{position:relative;z-index:1;display:inline-flex;align-items:center;height:32px;max-width:180px;flex:none;border-radius:8px;padding-right:4px}
.bt-ptab-fixed{padding-right:0}
.bt-ptab{position:relative;z-index:1;display:inline-flex;align-items:center;gap:6px;height:32px;max-width:180px;padding:0 8px;flex:none;border:0;border-radius:8px;background:none;color:var(--bt-ink-2);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap;transition:color .12s ease}
.bt-ptab-btn{max-width:none;min-width:0;flex:1 1 auto;padding:0 4px 0 8px}
.bt-ptab-fixed .bt-ptab-btn{padding:0 8px}
.bt-ptab:hover,.bt-ptab-wrap:hover .bt-ptab{color:var(--bt-ink)}
.bt-ptab[aria-selected=true]{color:var(--bt-ink)}
.bt-ptab:focus-visible,.bt-ptab-x:focus-visible,.bt-ptab-new:focus-visible{outline:2px solid var(--bt-accent);outline-offset:-2px}
.bt-ptab-bot{padding:0 7px}
.bt-ptab-bot .bt-mark{flex:none}
.bt-ptab-name{max-width:96px;overflow:hidden;text-overflow:ellipsis;font-weight:500;animation:bt-ptab-label .18s ease}
@keyframes bt-ptab-label{from{opacity:0;filter:var(--bt-fx-blur-4,blur(4px))}}
.bt-ptab-fav{width:14px;height:14px;flex:none;border-radius:3px;object-fit:cover;color:var(--bt-ink-3)}
.bt-ptab-globe{display:inline-flex}
.bt-ptab-globe svg{width:14px;height:14px}
.bt-ptab-title{max-width:140px;overflow:hidden;text-overflow:ellipsis}
.bt-ptab-x{flex:none;width:18px;height:18px;padding:0;border:0;border-radius:5px;background:none;display:inline-flex;align-items:center;justify-content:center;font:inherit;font-size:13px;line-height:1;color:var(--bt-ink-3);cursor:pointer;opacity:0;pointer-events:none;transition:opacity .12s ease,background-color .12s ease}
.bt-ptab-wrap:hover .bt-ptab-x,.bt-ptab-wrap:focus-within .bt-ptab-x,.bt-ptab-wrap[data-selected] .bt-ptab-x{opacity:1;pointer-events:auto}
.bt-ptab-x:hover{background:var(--bt-active);color:var(--bt-ink)}
.bt-ptab-new{position:relative;z-index:1;flex:none;width:28px;height:28px;margin:0 2px;border:0;border-radius:8px;background:none;color:var(--bt-ink-2);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;transition:background-color .12s ease,color .12s ease,transform .1s ease}
.bt-ptab-new:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bt-ptab-new:active{transform:scale(.94)}
.bt-ptab-new svg{width:15px;height:15px}
.bt-ptab-ind{position:absolute;top:4px;bottom:4px;border-radius:8px;background:var(--bt-hover);opacity:0;pointer-events:none;z-index:0;transition:opacity .15s ease}
.bt-ptab-close{flex:none;margin-left:auto}
.bt-panel-ghost{position:absolute;right:0;overflow:hidden;pointer-events:none;z-index:2}
.bt-panel-ghost>.bt-panel-view{position:absolute;inset:0}
.bt-panel-view{flex:1;min-height:0;display:flex;flex-direction:column;animation:bt-panel-view-in .22s cubic-bezier(.16,1,.3,1)}
.bt-panel-view[hidden]{display:none}
.bt-panel-workspace{overflow:hidden}
@keyframes bt-panel-view-in{from{opacity:0}}
/* While the panel changes width its views keep their final width on the right edge, so
   only the panel edge moves and nothing inside reflows frame by frame. */
.bt-panel[data-settling]{overflow:hidden}
.bt-panel[data-settling]:not([data-overlay])>.bt-ptabs,.bt-panel[data-settling]:not([data-overlay])>.bt-panel-view{flex-shrink:0;align-self:flex-end;box-sizing:border-box;width:calc(var(--bt-panel-w,320px) - .5px)}
.bt-panel[data-flying=tab] .bt-ptab-bot .bt-mark,.bt-panel[data-flying=drawer] .bt-drawer-id .bt-mark{visibility:hidden}
.bt-mark-fly{position:absolute;left:0;top:0;margin:0;transform-origin:0 0;z-index:5;pointer-events:none;will-change:transform}
.bt-panel-browser{position:relative}
.bt-browser-bar{position:relative;display:flex;align-items:center;gap:2px;height:52px;padding:0 10px 0 12px;flex:none;border-bottom:.5px solid var(--bt-line)}
.bt-browser-takeover{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 12px;background:var(--bt-hover);border-bottom:.5px solid var(--bt-line);font-size:12px;color:var(--bt-ink-2)}
.bt-browser-takeover[data-held]{background:var(--bt-active)}
.bt-browser-takeover-actions{display:flex;gap:6px}
.bt-browser-takeover button{border:1px solid var(--bt-line-2);border-radius:8px;padding:5px 9px;background:var(--bt-main);color:var(--bt-ink);font:inherit;cursor:pointer}
.bt-browser-bar .bt-icon-btn:disabled{opacity:.35;cursor:default;background:none}
.bt-browser-address{flex:1;min-width:0;display:flex;align-items:center;gap:6px;height:32px;margin:0 4px;padding:0 12px;border-radius:999px;background:var(--bt-hover);border:.5px solid transparent;transition:background-color .12s ease,border-color .12s ease,box-shadow .12s ease}
.bt-browser-address:hover{background:var(--bt-active)}
.bt-browser-address[data-editing]{background:var(--bt-main);border-color:var(--bt-line-2);box-shadow:0 2px 8px -1px rgba(0,0,0,.06),0 1px 2px rgba(0,0,0,.04)}
.bt-browser-scheme{display:inline-flex;color:var(--bt-ink-3);flex:none}
.bt-browser-scheme svg{width:14px;height:14px}
.bt-browser-address input{flex:1;min-width:0;border:0;background:none;outline:none;color:var(--bt-ink);font:inherit;font-size:13px;line-height:18px;padding:0;text-overflow:ellipsis}
.bt-browser-address input::placeholder{color:var(--bt-ink-3)}
.bt-browser-progress{position:absolute;left:0;right:0;bottom:-1px;height:2px;overflow:hidden;pointer-events:none}
.bt-browser-progress::after{content:"";position:absolute;inset:0;width:40%;background:var(--bt-accent,#4D6BFE);border-radius:2px;animation:bt-browser-load 1.1s cubic-bezier(.4,0,.2,1) infinite}
@keyframes bt-browser-load{from{transform:translateX(-100%)}to{transform:translateX(250%)}}
.bt-browser-frame{position:relative;flex:1;min-height:0;background:var(--bt-main)}
.bt-browser-frame[data-guest]{background:#fff}
.bt-browser-empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:32px;text-align:center;animation:bt-foot-in .3s ease}
.bt-browser-empty-title{font-size:15px;line-height:22px;font-weight:500;margin-top:6px}
.bt-browser-empty-text{max-width:300px;font-size:13px;line-height:19px;color:var(--bt-ink-2);overflow-wrap:anywhere}
.bt-browser-retry{margin-top:6px;height:32px;padding:0 14px;border-radius:999px;border:.5px solid var(--bt-line-2);background:var(--bt-main);color:var(--bt-ink);font:inherit;font-size:13px;cursor:pointer}
.bt-browser-retry:hover{background:var(--bt-hover)}
.bt-bcards{display:flex;flex-direction:column;gap:12px}
.bt-bcard{position:relative;border:.5px solid var(--bt-line-2);border-radius:12px;overflow:hidden;background:var(--bt-main);animation:bt-bcard-in .24s cubic-bezier(.16,1,.3,1) both;transition:border-color .12s ease,box-shadow .12s ease}
@keyframes bt-bcard-in{from{opacity:0;filter:var(--bt-fx-blur-4,blur(4px));transform:translateY(4px)}}
.bt-bcard[data-active]{border-color:var(--bt-accent,#4D6BFE);box-shadow:0 0 0 1px var(--bt-accent,#4D6BFE)}
.bt-bcard-shot{position:relative;display:block;width:100%;aspect-ratio:16/10;border:0;border-radius:12px 12px 0 0;background:var(--bt-hover);padding:0;cursor:pointer}
.bt-bcard-shot:focus-visible{outline:2px solid var(--bt-accent);outline-offset:-2px}
.bt-bcard-blank{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:var(--bt-ink-3);font-size:12px}
.bt-bcard-blank svg{width:20px;height:20px}
.bt-bcard-preview{position:absolute;inset:0;display:flex;flex-direction:column;gap:6px;padding:14px 16px;text-align:left;background:linear-gradient(to bottom,var(--bt-main),var(--bt-hover));overflow:hidden}
.bt-bcard-ptitle{font-size:13px;line-height:18px;font-weight:600;color:var(--bt-ink);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.bt-bcard-excerpt{font-size:12px;line-height:17px;color:var(--bt-ink-2);display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.bt-bcard-row{display:flex;align-items:center;gap:7px;padding:8px 10px;min-width:0}
.bt-bcard-fav{width:14px;height:14px;flex:none;border-radius:3px;color:var(--bt-ink-3)}
.bt-bcard-row svg.bt-bcard-fav{width:14px;height:14px}
.bt-bcard-title{flex:1;min-width:0;font-size:12px;line-height:17px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--bt-ink)}
.bt-bcard-host{flex:none;font-size:11px;line-height:15px;color:var(--bt-ink-3);max-width:38%;overflow:hidden;text-overflow:ellipsis}
.bt-bcard-x{position:absolute;top:6px;right:6px;width:22px;height:22px;border:0;border-radius:6px;background:color-mix(in srgb,var(--bt-main) 88%,transparent);color:var(--bt-ink-2);display:flex;align-items:center;justify-content:center;font-size:14px;cursor:pointer;opacity:0;pointer-events:none;transition:opacity .12s ease;backdrop-filter:blur(4px)}
.bt-bcard:hover .bt-bcard-x,.bt-bcard:focus-within .bt-bcard-x{opacity:1;pointer-events:auto}
.bt-bcard-new{display:flex;align-items:center;justify-content:center;gap:6px;height:40px;border:.5px dashed var(--bt-line-2);border-radius:12px;background:none;color:var(--bt-ink-3);font:inherit;font-size:12px;cursor:pointer}
.bt-bcard-new:hover{color:var(--bt-ink);border-color:var(--bt-ink-3)}
.bt-bcard-new svg{width:14px;height:14px}
.bt-browser-empty-mark{display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center}
/* Cookie imports */
.bt-import-btn[data-open]{background:var(--bt-active);color:var(--bt-ink)}
.bt-import-card{position:absolute;inset:0;z-index:6;display:flex;flex-direction:column;padding:28px 24px;background:var(--bt-main);overflow:auto;animation:bt-fade .14s ease-out}
.bt-import-box{width:100%;max-width:384px;margin:auto;box-sizing:border-box;overflow:visible}
.bt-import-box[data-morph]{overflow:hidden}
.bt-import-stage{display:flex;flex-direction:column;gap:14px;animation:bt-veil-in .18s ease-out}
.bt-import-head{display:flex;align-items:center;gap:10px;min-width:0}
.bt-import-head-mark{flex:none;display:inline-flex;align-items:center;justify-content:center;filter:drop-shadow(0 1px 2px rgba(0,0,0,.12))}
.bt-import-head-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.bt-import-head-btn{flex:none;margin-right:-6px}
.bt-import-head-btn:first-child{margin-left:-6px;margin-right:0}
.bt-import-title{font-size:15px;line-height:20px;font-weight:600;letter-spacing:-.015em;color:var(--bt-ink);font-variant-numeric:tabular-nums}
.bt-import-sub{font-size:12px;line-height:16px;color:var(--bt-ink-3);overflow-wrap:anywhere}
.bt-import-text{font-size:13px;line-height:20px;color:var(--bt-ink-2);overflow-wrap:anywhere}
.bt-import-section{display:flex;flex-direction:column;gap:4px}
.bt-import-label{padding:0 0 2px;font-size:12px;line-height:16px;font-weight:500;color:var(--bt-ink-3)}
.bt-import-rows{display:flex;flex-direction:column;gap:2px}
.bt-import-item{position:relative;display:flex;align-items:center;gap:12px;width:calc(100% + 20px);margin:0 -10px;min-width:0;min-height:48px;padding:8px 10px;border:0;border-radius:12px;background:transparent;color:var(--bt-ink);font:inherit;font-size:13px;line-height:18px;text-align:left;cursor:pointer;box-sizing:border-box;transition:background-color .12s ease,${spring(SPRING_TAP, 'scale')}}
.bt-import-item:hover{background:var(--bt-hover)}
.bt-import-item:active:not(:disabled){background:var(--bt-active);scale:.99}
.bt-import-item:focus-visible{outline:2px solid var(--bt-accent);outline-offset:-2px}
.bt-import-item:disabled{opacity:.45;cursor:default}
.bt-import-mark{flex:none;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;filter:drop-shadow(0 1px 2px rgba(0,0,0,.14))}
.bt-import-item-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.bt-import-item-subrow{display:flex;align-items:center;gap:6px;min-width:0}
.bt-import-item-name{min-width:0;font-size:14px;line-height:20px;font-weight:500;color:var(--bt-ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-import-item-email{min-width:0;font-size:12px;line-height:16px;color:var(--bt-ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-import-item-meta{flex:none;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.bt-import-item-tag{flex:none;font-size:11px;line-height:16px;font-weight:500;padding:0 6px;border-radius:4px;background:var(--bt-tag-bg);color:var(--bt-tag-ink)}
.bt-import-item-sub{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:16px;color:var(--bt-ink-3);font-variant-numeric:tabular-nums;white-space:nowrap}
.bt-import-item-sub[data-ready],.bt-import-item-sub[data-missing]{color:var(--bt-ink-2)}
.bt-import-dot{flex:none;width:6px;height:6px;border-radius:50%;corner-shape:round;background:var(--bt-ink-3)}
.bt-import-item-sub[data-ready] .bt-import-dot{background:color-mix(in srgb,var(--bt-green) 72%,var(--bt-ink))}
.bt-import-item-sub[data-missing] .bt-import-dot{background:var(--bt-danger)}
.bt-import-chev{flex:none;display:inline-flex;align-items:center;justify-content:flex-end;width:0;margin-left:-12px;overflow:hidden;color:var(--bt-ink-3);opacity:0;transform:translateX(-4px);transition:${spring(SPRING_SHAPE, 'width', 'margin-left', 'transform')},opacity .14s ease}
.bt-import-chev svg{flex:none;width:14px;height:14px}
.bt-import-item:hover .bt-import-chev,.bt-import-item:focus-visible .bt-import-chev{width:14px;margin-left:0;opacity:.7;transform:none}
.bt-import-sep{height:1px;background:var(--bt-line);margin:2px 0}
.bt-import-item-alt{min-height:40px;padding:7px 10px;border-radius:10px;gap:10px}
.bt-import-item-alt .bt-import-item-name{font-size:13px;line-height:18px;font-weight:400;flex:none}
.bt-import-alt-ico{flex:none;width:28px;display:inline-flex;align-items:center;justify-content:center;color:var(--bt-ink-2);transition:color .12s ease}
.bt-import-alt-ico svg{width:16px;height:16px}
.bt-import-item-alt:hover .bt-import-alt-ico{color:var(--bt-ink)}
.bt-import-alt-hint{flex:1;min-width:0;text-align:right;font-size:11px;line-height:16px;color:var(--bt-ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-import-menu-note{padding:16px 0;font-size:13px;line-height:18px;color:var(--bt-ink-3)}
.bt-import-skel-row{display:flex;align-items:center;gap:12px;padding:10px 0}
.bt-import-skel-ico{flex:none;width:26px;height:26px;border-radius:50%;corner-shape:round;background:var(--bt-hover);animation:bt-import-pulse 1.4s ease-in-out infinite}
.bt-import-skel-lines{flex:1;display:flex;flex-direction:column;gap:6px}
.bt-import-skel-bar{height:10px;border-radius:4px;background:var(--bt-hover);animation:bt-import-pulse 1.4s ease-in-out infinite}
.bt-import-skel-w1{width:54%}
.bt-import-skel-w2{width:34%;height:8px}
.bt-import-skel-w3{width:46%}
@keyframes bt-import-pulse{0%,100%{opacity:.45}50%{opacity:.9}}
.bt-import-steps{display:flex;flex-direction:column;gap:10px;padding:14px 16px;border-radius:12px;background:var(--bt-hover)}
.bt-import-step{font-size:13px;line-height:19px;color:var(--bt-ink-2)}
.bt-import-copy-row{display:flex;align-items:center;gap:8px;padding:5px 5px 5px 12px;border-radius:8px;background:var(--bt-card);box-shadow:var(--bt-card-shadow);min-width:0}
.bt-import-code{flex:1;min-width:0;color:var(--bt-ink);font-family:var(--bt-mono);font-size:12px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;user-select:all}
.bt-import-mini{flex:none;display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 10px;border:0;border-radius:6px;background:var(--bt-hover);color:var(--bt-ink);font:inherit;font-size:12px;font-weight:500;cursor:pointer;transition:background-color .12s ease,${spring(SPRING_TAP, 'scale')}}
.bt-import-mini svg{width:13px;height:13px;color:var(--bt-ink-2)}
.bt-import-mini:hover{background:var(--bt-active)}
.bt-import-mini:active{scale:.96}
.bt-import-mini:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-import-ready-note{display:flex;align-items:center;gap:8px;padding:9px 12px;border-radius:10px;background:color-mix(in srgb,var(--bt-green) 10%,transparent);font-size:12px;line-height:16px;font-weight:500;color:var(--bt-ink-2)}
.bt-import-ready-note svg{flex:none;width:15px;height:15px;color:color-mix(in srgb,var(--bt-green) 72%,var(--bt-ink))}
.bt-import-textarea{width:100%;box-sizing:border-box;min-height:120px;max-height:220px;resize:vertical;padding:12px 14px;border:1px solid transparent;border-radius:12px;background:var(--bt-hover);color:var(--bt-ink);font-family:var(--bt-mono);font-size:12px;line-height:18px;outline:none;transition:background-color .12s ease,border-color .12s ease,box-shadow .12s ease}
.bt-import-input{width:100%;box-sizing:border-box;height:36px;padding:0 12px;border:1px solid transparent;border-radius:10px;background:var(--bt-hover);color:var(--bt-ink);font:inherit;font-size:13px;outline:none;transition:background-color .12s ease,border-color .12s ease,box-shadow .12s ease}
.bt-import-textarea:focus,.bt-import-input:focus{background:var(--bt-card);border-color:var(--bt-accent);box-shadow:0 0 0 3px var(--bt-accent-soft)}
.bt-import-input::placeholder,.bt-import-textarea::placeholder,.bt-import-search-in::placeholder{color:var(--bt-ink-3)}
.bt-import-scope{width:100%;box-sizing:border-box}
.bt-import-scope button{min-width:0;padding:0 10px;font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-import-scope button[aria-pressed=true]{background:var(--bt-nav-thumb-bg);box-shadow:var(--bt-nav-thumb-shadow)}
.bt-import-scope>.bt-thumb{background:var(--bt-nav-thumb-bg);box-shadow:var(--bt-nav-thumb-shadow)}
.bt-import-scope[data-glide] button[aria-pressed=true]{background:transparent;box-shadow:none}
.bt-import-scope>.bt-thumb[data-hidden]{opacity:0}
.bt-import-search{display:flex;align-items:center;gap:6px;height:34px;padding:0 4px 0 11px;border-radius:10px;background:var(--bt-hover);border:1px solid transparent;transition:background-color .12s ease,border-color .12s ease,box-shadow .12s ease}
.bt-import-search:focus-within{background:var(--bt-card);border-color:var(--bt-accent);box-shadow:0 0 0 3px var(--bt-accent-soft)}
.bt-import-search-ico{flex:none;display:inline-flex;color:var(--bt-ink-3)}
.bt-import-search-ico svg{width:14px;height:14px}
.bt-import-search-in{flex:1;min-width:0;border:0;background:none;outline:none;color:var(--bt-ink);font:inherit;font-size:13px;line-height:18px;padding:0}
.bt-import-search-btn{flex:none;height:26px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:var(--bt-ink-2);font:inherit;font-size:12px;font-weight:500;cursor:pointer;transition:background-color .12s ease,color .12s ease}
.bt-import-search-btn:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bt-import-search-btn:focus-visible{outline:2px solid var(--bt-accent);outline-offset:-2px}
.bt-import-list{max-height:220px;overflow:auto;margin:0 -8px;padding:2px 0;display:flex;flex-direction:column;gap:1px}
.bt-import-list-empty{padding:20px 12px;font-size:12px;line-height:16px;color:var(--bt-ink-3);text-align:center}
.bt-import-line{position:relative;display:flex;align-items:center;gap:10px;min-height:36px;padding:6px 8px;border-radius:8px;min-width:0;box-sizing:border-box;transition:background-color .12s ease}
.bt-import-check-row{cursor:pointer;user-select:none}
.bt-import-check-row:hover{background:var(--bt-hover)}
.bt-import-cb-input{position:absolute;opacity:0;width:1px;height:1px;margin:0;pointer-events:none}
.bt-import-cb{flex:none;width:16px;height:16px;border-radius:4px;border:1.5px solid var(--bt-line-2);background:transparent;color:var(--bt-accent-ink);display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;transition:background-color .12s ease,border-color .12s ease}
.bt-import-cb svg{width:11px;height:11px;stroke-width:2.2;animation:bt-import-pop ${SPRING_POP.duration}ms ${SPRING_POP.easing}}
@keyframes bt-import-pop{from{scale:.5;opacity:0}}
.bt-import-check-row[data-checked] .bt-import-cb{border-color:var(--bt-accent);background:var(--bt-accent)}
.bt-import-check-row:has(.bt-import-cb-input:focus-visible) .bt-import-cb{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-import-line-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:18px;color:var(--bt-ink-3);transition:color .12s ease}
.bt-import-check-row[data-checked] .bt-import-line-name{color:var(--bt-ink)}
.bt-import-line-count{flex:none;text-align:right;font-size:12px;line-height:16px;color:var(--bt-ink-3);font-variant-numeric:tabular-nums;white-space:nowrap}
.bt-import-line-reason{flex:1;min-width:0;font-size:11px;line-height:16px;color:var(--bt-ink-3);overflow-wrap:anywhere}
.bt-import-opt-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:12px;border-top:1px solid var(--bt-line)}
.bt-import-opt-label{font-size:13px;line-height:18px;color:var(--bt-ink-2)}
.bt-import-meta-group{display:flex;flex-direction:column;gap:2px}
.bt-import-disclosure{font-size:12px;color:var(--bt-ink-3)}
.bt-import-disclosure summary{display:flex;align-items:center;gap:4px;padding:3px 0;list-style:none;cursor:pointer;color:var(--bt-ink-3);user-select:none;transition:color .12s ease}
.bt-import-disclosure summary::-webkit-details-marker{display:none}
.bt-import-disclosure summary:hover{color:var(--bt-ink-2)}
.bt-import-disc-chev{display:inline-flex;color:var(--bt-ink-3);transition:${spring(SPRING_SHAPE, 'transform')}}
.bt-import-disc-chev svg{width:13px;height:13px}
.bt-import-disclosure[open] .bt-import-disc-chev{transform:rotate(90deg)}
.bt-import-disc-body{display:flex;flex-direction:column;gap:2px;margin-top:4px;padding:8px 12px;border-radius:10px;background:var(--bt-hover);max-height:112px;overflow:auto}
.bt-import-detail-line{display:flex;align-items:baseline;gap:8px;padding:2px 0;min-width:0}
.bt-import-detail-name{flex:none;max-width:52%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:16px;color:var(--bt-ink-2)}
.bt-import-callout{display:flex;align-items:flex-start;gap:6px;font-size:12px;line-height:16px;color:var(--bt-ink-3)}
.bt-import-callout svg{flex:none;width:14px;height:14px;margin-top:1px;color:var(--bt-ink-3)}
.bt-import-status{align-items:center;text-align:center}
.bt-import-status .bt-import-actions{width:100%;justify-content:center;margin-top:6px}
.bt-import-status-orbit{position:relative;width:54px;height:54px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:4px}
.bt-import-orbit-ring{position:absolute;inset:0;border-radius:50%;corner-shape:round;border:1.5px solid var(--bt-line);border-top-color:var(--bt-accent);box-sizing:border-box;animation:bt-import-spin .85s linear infinite}
.bt-import-status-badge{width:44px;height:44px;border-radius:50%;corner-shape:round;display:inline-flex;align-items:center;justify-content:center;margin-bottom:4px;animation:bt-import-pop ${SPRING_POP.duration}ms ${SPRING_POP.easing}}
.bt-import-status-badge svg{width:20px;height:20px}
.bt-import-status-ok{background:color-mix(in srgb,var(--bt-green) 14%,transparent);color:color-mix(in srgb,var(--bt-green) 72%,var(--bt-ink))}
.bt-import-status-err{background:var(--bt-danger-soft);color:var(--bt-danger)}
.bt-import-status-muted{background:var(--bt-hover);color:var(--bt-ink-2)}
@keyframes bt-import-spin{to{transform:rotate(360deg)}}
.bt-import-problems{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:10px;background:var(--bt-hover);text-align:left;max-height:140px;overflow:auto}
.bt-import-actions{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;margin-top:4px}
.bt-import-primary{height:36px;padding:0 18px;border:0;border-radius:999px;background:var(--bt-accent);color:var(--bt-accent-ink);font:inherit;font-size:13px;font-weight:500;cursor:pointer;transition:opacity .12s ease,filter .12s ease,${spring(SPRING_TAP, 'scale')}}
.bt-import-primary:hover:not(:disabled){filter:brightness(1.06)}
.bt-import-primary:active:not(:disabled){scale:.96}
.bt-import-primary:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-import-primary:disabled{opacity:.4;cursor:default}
.bt-import-plain{height:36px;padding:0 16px;border:0;border-radius:999px;background:var(--bt-hover);color:var(--bt-ink);font:inherit;font-size:13px;font-weight:500;cursor:pointer;transition:background-color .12s ease,opacity .12s ease,${spring(SPRING_TAP, 'scale')}}
.bt-import-plain:hover:not(:disabled){background:var(--bt-active)}
.bt-import-plain:active:not(:disabled){scale:.96}
.bt-import-plain:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-import-plain:disabled{opacity:.4;cursor:default}
@media (prefers-reduced-motion:reduce){.bt-import-card,.bt-import-stage,.bt-import-cb svg,.bt-import-status-badge,.bt-import-skel-ico,.bt-import-skel-bar{animation:none!important}.bt-import-item,.bt-import-mini,.bt-import-primary,.bt-import-plain,.bt-import-chev,.bt-import-disc-chev{transition:none!important}}
.bt-browser-empty-icon{width:44px;height:44px;border-radius:12px;background:var(--bt-hover);color:var(--bt-ink-2);display:inline-flex;align-items:center;justify-content:center}
.bt-browser-empty-icon svg{width:22px;height:22px}
/* A viewport too narrow to leave the conversation its room: the panel covers it,
   and its close controls get a touch-sized target. */
.bt-panel[data-overlay]{width:100vw}
.bt-panel[data-overlay] .bt-ptab-close,.bt-panel[data-overlay] .bt-drawer-top .bt-round{width:44px;height:44px}
/* Touch: the hidden-but-tappable tab and card close buttons stay visible at a
   finger-sized target instead. */
@media (hover:none){
  .bt-ptabs{height:52px}
  .bt-ptab-wrap,.bt-ptab{height:44px}
  .bt-ptab-x,.bt-bcard-x{opacity:1;pointer-events:auto;width:44px;height:44px}
  .bt-ptab-close{width:44px;height:44px}
}
@media (prefers-reduced-motion:reduce){.bt-ptabs,.bt-panel-view,.bt-bcard,.bt-ptab-name,.bt-browser-progress::after{animation:none}}
`
