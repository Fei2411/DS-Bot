// The Bot panel: one right-hand column holding a Bot's details, its browser or a
// side chat. A tab strip on top flips between them — the Bot page collapses to a
// tab, each browser tab and side chat is a tab of its own. Browser pages are
// Electron webviews kept in a body-level layer by bot-browsers.js; the panel
// draws the strip and the toolbar and reports the rectangle the shown webview
// covers.
import { createElement as h, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { BotMark } from './mark.js'
import { STORAGE } from './storage.js'
import { MIN_CHAT } from './frame-layout.js'
import { chatRoom } from './frame-watch.js'
import { SPRING_LEAD, SPRING_SHAPE, SPRING_TRAIL, reducedMotion, stepMenuFocus, useLinger } from './motion.js'
import { FLIGHT_ENDS, INTENT_MS, createFlight, flightEnd, flightStart, planFlight, uniqueIds } from './mark-flight.js'
import { DetailsDrawer } from './details-drawer.js'
import { SideChatView } from './side-chat.js'
import { TaskReaderView } from './bot-tasks.js'
import { panelHasStrip, sideChatsOf, stripMenuKeys } from './side-model.js'
import { DotsIcon, FolderIcon, SideIcon, TerminalIcon } from './icons.js'
import { t } from './i18n.js'
import { rectsOverlap } from './browser-overlap.js'
import { useEscape } from './overlay-hooks.js'
import { writeClipboard } from './dsh-primitives.js'

export const PANEL_LINGER_MS = 300
const WIDTH_KEY = STORAGE.browserWidth
// One width for the panel, shared by both views. The Bot page keeps it within
// DETAILS_WIDTH..DETAILS_MAX, so a wider browser comes back to DETAILS_MAX and a
// narrower one keeps its width; the browser takes any width from MIN_WIDTH.
const DEFAULT_WIDTH = 520
const DETAILS_WIDTH = 320
const DETAILS_MAX = 520
const MIN_WIDTH = 360
// How long the Bot's mark shows that it read the page.
const READ_FLASH_MS = 2400
const EMPTY_PAGE = { url: '', title: '', favicon: null, loading: false, canGoBack: false, canGoForward: false, error: null, excerpt: '' }
const EMPTY_TABS = { ids: [], active: null }

const icon = paths => function BrowserIcon() {
  return h('svg', { width: 16, height: 16, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    paths.map((d, index) => h('path', { key: index, d })))
}
export const GlobeIcon = icon(['M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M3 10h14', 'M10 3c2 2.2 2.9 4.5 2.9 7S12 14.8 10 17c-2-2.2-2.9-4.5-2.9-7S8 5.2 10 3z'])
const BackIcon = icon(['M12.5 4.5L7 10l5.5 5.5'])
const ForwardIcon = icon(['M7.5 4.5L13 10l-5.5 5.5'])
const ReloadIcon = icon(['M15.5 10a5.5 5.5 0 1 1-1.6-3.9', 'M15.5 3.5v3.5H12'])
const StopIcon = icon(['M5.5 5.5l9 9M14.5 5.5l-9 9'])
const CloseIcon = icon(['M5.5 5.5l9 9M14.5 5.5l-9 9'])
const PlusTabIcon = icon(['M10 5v10M5 10h10'])
const LockIcon = icon(['M6.5 9V7a3.5 3.5 0 0 1 7 0v2', 'M5.5 9h9v7h-9z'])
const ImportIcon = icon(['M10 3.5v8.5', 'M6 8.5l4 4 4-4', 'M4.5 14v1.5a1.5 1.5 0 0 0 1.5 1.5h8a1.5 1.5 0 0 0 1.5-1.5V14'])
const FileIcon = icon(['M6 3.5h5.5L14.5 6.5v10H6z', 'M11 3.5v3.5h3.5'])
const WindowIcon = icon(['M4 5h12v9.5H4z', 'M4 7.5h12'])
const PasteIcon = icon(['M7.5 4.5h5v2h-5z', 'M6 5.5H5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1h-1'])

/** Whether a cookie site belongs to the same host or direct domain hierarchy as the current tab. */
export function siteMatchesHost(site, host) {
  const s = String(site ?? '').replace(/^\.+/, '').toLowerCase()
  const h = String(host ?? '').replace(/^\.+/, '').toLowerCase()
  if (!s || !h) return false
  if (s === h) return true
  // Never match bare single-label TLDs as parents (only real multi-label domains).
  if (s.includes('.') && h.endsWith(`.${s}`)) return true
  if (h.includes('.') && s.endsWith(`.${h}`)) return true
  return false
}

const hostOfUrl = (url) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null
  try { return new URL(url).hostname.toLowerCase() } catch { return null }
}

const lastImportSource = () => {
  try { return localStorage.getItem(STORAGE.browserImportSource) || null } catch { return null }
}

const saveLastImportSource = (id) => {
  if (!id) return
  try { localStorage.setItem(STORAGE.browserImportSource, String(id)) } catch { /* storage unavailable */ }
}

export function orderImportSources(sources, lastId) {
  if (!Array.isArray(sources) || !lastId) return sources ?? []
  const index = sources.findIndex((s) => s.id === lastId)
  if (index <= 0) return sources
  return [sources[index], ...sources.slice(0, index), ...sources.slice(index + 1)]
}

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
const widthRange = (view, room) => (view === 'browser'
  ? [MIN_WIDTH, room - MIN_CHAT]
  : [DETAILS_WIDTH, Math.min(DETAILS_MAX, room - MIN_CHAT)])
const fitWidth = (width, [low, high]) => Math.round(Math.max(low, Math.min(width, high)))
// The address as the bar shows it while not editing: no scheme, no trailing slash.
const shortAddress = url => String(url ?? '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '')

const tabLabel = page => page.title || shortAddress(page.url) || t('New tab')

// The `···` popover anchored to its button. `items` holds {key, icon, label,
// onPick} and {sep:true} entries; Escape or a click outside closes it. The
// callers hide the button when the list is empty.
export function PanelMenu({ items, className, 'aria-label': label }) {
  const [open, setOpen] = useState(false)
  const [shown, leaving] = useLinger(open, 120)
  const wrap = useRef(null)
  const button = useRef(null)
  useEscape(() => { setOpen(false); button.current?.focus() }, open)
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
    }, h(DotsIcon)),
    shown ? h('div', { className: 'bt-pmenu-pop', role: 'menu', 'data-leaving': leaving || undefined },
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
// collapsed), then one tab per browser page, one per side chat, then `···` and
// close.
export function PanelStrip({ bot, roomSubject, subject, view, ids, active, sides, side, task, canBrowse, reading, onView, actions, useBrowserPages }) {
  const pages = useBrowserPages(map => map)
  const wrap = useRef(null)
  const ind = useRef(null)
  const spot = useRef(null)
  const under = useRef(null)
  const watcher = useRef(null)
  const observed = useRef(new Set())
  const stripKey = [
    bot?.name ?? roomSubject?.name ?? '',
    ids.map(tabId => `${tabId}:${tabLabel(pages[tabId] ?? EMPTY_PAGE)}`).join('\0'),
    sides.map(chat => `${chat.id}:${sideTitle(chat)}`).join('\0'),
    task ? `${task.id}:${task.title}` : '',
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
        ? box.querySelector(`[data-side="${side}"]`)
        : view === 'task' && task
          ? box.querySelector(`[data-task="${task.id}"]`)
          : box.querySelector(`[data-tab="${active}"]`)
    under.current = node
    syncObserved()
    if (!node) { capsule.style.opacity = '0'; spot.current = null; return undefined }
    // The Bot tab is pinned at the strip's start; showing it scrolls the pages back
    // so the capsule and the pinned tab line up.
    if (view === 'details') box.scrollLeft = 0
    else node.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    const to = { left: node.offsetLeft, right: box.offsetWidth - node.offsetLeft - node.offsetWidth }
    const from = spot.current
    spot.current = to
    capsule.style.opacity = '1'
    capsule.style.left = `${to.left}px`
    capsule.style.right = `${to.right}px`
    if (from === null || (from.left === to.left && from.right === to.right) || reducedMotion()) return undefined
    const ahead = to.left > from.left ? 'right' : 'left'
    const behind = ahead === 'right' ? 'left' : 'right'
    const lead = capsule.animate([{ [ahead]: `${from[ahead]}px` }, { [ahead]: `${to[ahead]}px` }], { duration: SPRING_LEAD.duration, easing: SPRING_LEAD.easing })
    const trail = capsule.animate([{ [behind]: `${from[behind]}px` }, { [behind]: `${to[behind]}px` }], { duration: SPRING_TRAIL.duration, easing: SPRING_TRAIL.easing })
    return () => { lead.cancel(); trail.cancel() }
  }, [view, active, side, stripKey])
  // A drag resizes the strip without a render; sibling tab widths can change too
  // (e.g. a title or font loading), shifting the active tab's offsetLeft.
  useEffect(() => {
    const box = wrap.current
    if (!box) return undefined
    const observer = new ResizeObserver(() => {
      const node = under.current
      const capsule = ind.current
      if (!node?.isConnected || !capsule || spot.current === null) return
      spot.current = { left: node.offsetLeft, right: box.offsetWidth - node.offsetLeft - node.offsetWidth }
      capsule.style.left = `${spot.current.left}px`
      capsule.style.right = `${spot.current.right}px`
    })
    watcher.current = observer
    observer.observe(box)
    syncObserved()
    return () => { watcher.current = null; observed.current.clear(); observer.disconnect() }
  }, [])
  const items = stripMenuKeys({
    canBrowse,
    canSide: Boolean(bot),
    canTerminal: actions.canOpenTerminal?.() === true,
    canFiles: actions.canOpenFiles?.() === true,
  }).map(key => menuItemFor(key, actions, subject))
  // `data-window-drag` is the shell's window drag-row mark on macOS: base.css turns it
  // into the drag geometry, and the shell's watcher re-collects that geometry while the
  // panel slides in. The rule in styles.js declares the same row for a shell without it.
  return h('div', { className: 'bt-ptabs', role: 'tablist', 'data-window-drag': true, 'aria-label': t('Panel tabs') },
    h('div', { className: 'bt-ptabs-in', ref: wrap },
      h('button', {
        type: 'button', role: 'tab', 'aria-selected': view === 'details', className: 'bt-ptab bt-ptab-bot',
        title: bot?.name ?? roomSubject?.name ?? t('Details'), onClick: () => onView('details'),
      },
        bot ? h(BotMark, { bot, size: 20, state: reading ? 'searching' : 'idle' }) : null,
        view === 'details' || !bot ? h('span', { className: 'bt-ptab-name' }, bot?.name ?? roomSubject?.name ?? t('Details')) : null),
      ids.map((tabId) => {
        const page = pages[tabId] ?? EMPTY_PAGE
        const on = view === 'browser' && tabId === active
        return h('div', {
          key: tabId, role: 'presentation', 'data-tab': tabId, 'data-selected': on || undefined, className: 'bt-ptab-wrap',
        },
          h('button', {
            type: 'button', role: 'tab', 'aria-selected': on, className: 'bt-ptab bt-ptab-btn',
            title: page.url || t('New tab'),
            onClick: () => { actions.browserActivate(bot.id, tabId); onView('browser') },
            onAuxClick: (event) => { if (event.button === 1) { event.preventDefault(); void actions.browserCloseTab(bot.id, tabId) } },
          },
            h(Favicon, { src: page.favicon, className: 'bt-ptab-fav' }),
            h('span', { className: 'bt-ptab-title' }, tabLabel(page))),
          h('button', {
            type: 'button', className: 'bt-ptab-x', 'aria-label': t('Close tab'), title: t('Close tab'),
            onClick: () => { void actions.browserCloseTab(bot.id, tabId) },
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
      h('span', { ref: ind, className: 'bt-ptab-ind', 'aria-hidden': true })),
    // The `···` and Close stay outside the scrolling tabs, so a narrow panel keeps both.
    items.length > 0 ? h(PanelMenu, { items, className: 'bt-ptab-new', 'aria-label': t('More') }) : null,
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
    if (record.type === 'attributes') return true
    if (!isElementNode(record.target) || !record.target.closest?.('[data-chat-flow]')) return true
    if (record.target.closest?.(OVERLAY_SELECTOR)) return true
    return hasOverlayNode(record.addedNodes) || hasOverlayNode(record.removedNodes)
  })
}

// The browser view: toolbar (back, forward, reload/stop, address) over the frame
// the guest webview covers.
export function BrowserView({ bot, tabId, leaving, landed, actions, useBrowserPages, hold }) {
  const page = useBrowserPages(pages => pages[tabId ?? '']) ?? EMPTY_PAGE
  const frame = useRef(null)
  const input = useRef(null)
  const [draft, setDraft] = useState(null)
  const [covered, setCovered] = useState(false)

  // Cookie imports (the desktop app's bridge only): 'menu' lists browser profiles first,
  // then file/paste; a card stage runs connecting / remote-debug / running / paste →
  // preview → result | error above the guest.
  const imports = actions.browserImport
  const [flow, setFlow] = useState(null)
  // A mirrored flow: the cleanup on leaving the tab or the panel can still cancel
  // an unconfirmed pending import or an in-flight live harvest.
  const flowRef = useRef(null)
  const reqRef = useRef(0)
  const liveReqIdRef = useRef(null)
  const [sources, setSources] = useState(null)
  const [lastSourceId, setLastSourceId] = useState(lastImportSource)
  const [busy, setBusy] = useState(false)
  const setFlowTracked = (next) => {
    flowRef.current = typeof next === 'function' ? next(flowRef.current) : next
    setFlow(flowRef.current)
  }
  const cancelPendingImport = () => {
    const liveId = liveReqIdRef.current
    liveReqIdRef.current = null
    if (liveId) void imports?.cancel(liveId).catch(() => {})
    const id = typeof flowRef.current === 'object' && flowRef.current !== null ? flowRef.current.id : null
    if (id) void imports?.cancel(id).catch(() => {})
  }

  // The guest goes on screen once the panel has landed and settled on its width,
  // and only over a page: the empty, error and import states are the panel's own.
  const showGuest = landed && !leaving && !covered && Boolean(page.url) && !page.error && flow === null

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

  // Leaving the tab or the panel abandons an unconfirmed or in-flight import.
  useEffect(() => {
    reqRef.current += 1
    cancelPendingImport()
    setFlowTracked(null)
    return () => {
      reqRef.current += 1
      cancelPendingImport()
    }
    // The flow controls live in this component; the effect re-runs only per tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId])

  const refreshSources = () => {
    if (!imports) return
    void imports.sources().then(
      (list) => setSources(Array.isArray(list) ? list : []),
      () => setSources((prev) => prev ?? []),
    )
  }
  const openImport = () => {
    reqRef.current += 1
    setBusy(false)
    cancelPendingImport()
    setFlowTracked('menu')
    setLastSourceId(lastImportSource())
    refreshSources()
  }
  const showPicked = (r, token) => {
    if (token !== undefined && token !== reqRef.current) {
      if (r?.id) void imports?.cancel(r.id).catch(() => {})
      return
    }
    if (r?.canceled) return
    if (r?.id) setFlowTracked({ stage: 'preview', id: r.id, preview: r.preview, restarted: r.restarted === true, method: r.method ?? null })
    else if (r?.error) setFlowTracked({ stage: 'error', message: importError(r.error) })
    else setFlowTracked(null)
  }
  const job = async (work) => {
    const token = ++reqRef.current
    setBusy(true)
    try { await work(token) } catch (error) {
      if (token === reqRef.current) setFlowTracked({ stage: 'error', message: String(error?.message ?? error) })
    } finally {
      if (token === reqRef.current) setBusy(false)
    }
  }
  const pickFile = () => job(async (token) => showPicked(await imports.pick(), token))
  const openPaste = () => {
    reqRef.current += 1
    setBusy(false)
    cancelPendingImport()
    setFlowTracked({ stage: 'paste', siteUrl: hostOfUrl(page.url) ? page.url : '' })
  }
  const submitPaste = (text, siteUrl) => job(async (token) => {
    if (!imports?.paste) return
    showPicked(await imports.paste(text, siteUrl || undefined), token)
  })
  const runLiveImport = async (source, close, token) => {
    const prevLive = liveReqIdRef.current
    if (prevLive) void imports?.cancel(prevLive).catch(() => {})
    const requestId = `live-${Date.now()}-${token}`
    liveReqIdRef.current = requestId
    try {
      return await imports.live(source.id, close, requestId)
    } finally {
      if (liveReqIdRef.current === requestId) liveReqIdRef.current = null
    }
  }
  const pickSource = (source) => job(async (token) => {
    setFlowTracked({ stage: 'connecting', source })
    const r = await runLiveImport(source, false, token)
    if (token !== reqRef.current) {
      if (r?.id) void imports?.cancel(r.id).catch(() => {})
      return
    }
    if (r?.canceled) return
    if (r?.needsRemoteDebugging) setFlowTracked({ stage: 'remote-debug', source, info: r })
    else if (r?.running) setFlowTracked({ stage: 'running', source })
    else showPicked(r, token)
  })
  const closeAndImport = () => job(async (token) => {
    const source = flowRef.current?.source
    if (!source) return
    const r = await runLiveImport(source, true, token)
    if (token !== reqRef.current) {
      if (r?.id) void imports?.cancel(r.id).catch(() => {})
      return
    }
    if (r?.canceled) return
    if (r?.needsRemoteDebugging) setFlowTracked({ stage: 'remote-debug', source, info: r })
    else showPicked(r, token)
  })
  const applyImport = (options) => job(async (token) => {
    const current = flowRef.current
    if (!current?.id) return
    const report = await imports.apply(bot.id, current.id, options)
    if (token !== reqRef.current) return
    const sourceId = current.preview?.source?.id
    if (sourceId) { saveLastImportSource(sourceId); setLastSourceId(sourceId) }
    const shouldReload = Boolean(page.url) && ((report?.stored ?? 0) > 0 || (report?.originsStored ?? 0) > 0)
    if (shouldReload) void actions.browserCommand(tabId, 'reload')
    setFlowTracked({
      stage: 'result',
      report,
      label: current.preview?.source?.label ?? null,
      reloaded: shouldReload,
    })
  })
  const cancelImport = () => {
    reqRef.current += 1
    setBusy(false)
    cancelPendingImport()
    setFlowTracked(null)
  }
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
    if (landed && !page.url) input.current?.focus()
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
  useEscape(() => { setDraft(null); input.current?.blur() }, editing)
  const secure = /^https:/i.test(page.url)
  return h('div', { className: 'bt-panel-view bt-panel-browser', 'aria-label': t("{name}'s browser", { name: bot.name }) },
    actions.browserTakeover ? h('div', { className: 'bt-browser-takeover', 'data-held': hold?.by === 'user' || undefined },
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
        type: 'button', className: 'bt-icon-btn', disabled: !page.url,
        'aria-label': page.loading ? t('Stop') : t('Reload'), title: page.loading ? t('Stop') : t('Reload'),
        onClick: () => actions.browserCommand(tabId, page.loading ? 'stop' : 'reload'),
      }, h(page.loading ? StopIcon : ReloadIcon)),
      h('form', { className: 'bt-browser-address', onSubmit: go, 'data-editing': editing || undefined },
        h('span', { className: 'bt-browser-scheme', 'aria-hidden': true }, h(secure && !editing ? LockIcon : GlobeIcon)),
        h('input', {
          ref: input, type: 'text', spellCheck: false, autoComplete: 'off', 'aria-label': t('Address'),
          placeholder: t('Search or enter address'),
          value: editing ? draft : shortAddress(page.url),
          onFocus: (event) => { setDraft(page.url); const target = event.target; requestAnimationFrame(() => target.select()) },
          onBlur: () => setDraft(null),
          onChange: event => setDraft(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Escape' && !event.nativeEvent?.isComposing && event.keyCode !== 229) {
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
        onClick: () => actions.browserNewTab(bot.id),
      }, h(PlusTabIcon)),
      imports ? h('button', {
        type: 'button', className: 'bt-icon-btn bt-import-btn', 'aria-label': t('Import cookies'), title: t('Import cookies'),
        'aria-expanded': flow === 'menu', disabled: busy,
        onClick: () => { if (flow === 'menu') setFlowTracked(null); else openImport() },
      }, h(ImportIcon)) : null,
      page.loading ? h('span', { className: 'bt-browser-progress', 'aria-hidden': true }) : null),
    h('div', { ref: frame, className: 'bt-browser-frame', 'data-guest': showGuest || undefined },
      flow === 'menu' ? h(ImportMenu, {
        sources: orderImportSources(sources, lastSourceId),
        lastSourceId,
        loading: sources === null,
        busy,
        canPaste: Boolean(imports?.paste),
        onFile: pickFile,
        onPaste: openPaste,
        onSource: pickSource,
        onClose: () => setFlowTracked(null),
      }) : null,
      typeof flow === 'object' && flow !== null
        ? h(ImportCard, {
          flow,
          page,
          busy,
          imports,
          onApply: applyImport,
          onCancel: cancelImport,
          onCloseAndImport: closeAndImport,
          onRetrySource: () => { if (flow.source) void pickSource(flow.source) },
          onLaunchSource: () => { if (flow.source && imports?.launch) void imports.launch(flow.source.id) },
          onFile: pickFile,
          onSubmitPaste: submitPaste,
          onDone: () => setFlowTracked(null),
          onReload: () => actions.browserCommand(tabId, 'reload'),
        })
        : null,
      flow === null && page.error
        ? h('div', { className: 'bt-browser-empty' },
            h('div', { className: 'bt-browser-empty-title' }, t('This page didn’t load')),
            h('div', { className: 'bt-browser-empty-text' }, t(page.error)),
            page.url ? h('button', { type: 'button', className: 'bt-browser-retry', onClick: () => { void actions.browserNavigate(tabId, page.url) } }, t('Try again')) : null)
        : flow === null && !page.url
          ? h('div', { className: 'bt-browser-empty' },
              h(BotMark, { bot, size: 48, state: 'idle', live: true }),
              h('div', { className: 'bt-browser-empty-title' }, t("{name}'s browser", { name: bot.name })),
              h('div', { className: 'bt-browser-empty-text' }, t('Open a page here and {name} can read it with you. Logins and cookies stay with {name}; other Bots never see them.', { name: bot.name })),
              imports ? h('button', { type: 'button', className: 'bt-browser-retry', onClick: openImport }, t('Import cookies')) : null)
          : null))
}


function importError(error) {
  if (error === 'too-large') return t('That file is too large to be a cookie export.')
  if (error === 'unreadable') return t('That file could not be read.')
  if (error === 'app-bound') return t('This browser encrypts its cookies so only it can read them. Export them to a file first, then import that file.')
  if (error === 'keychain-denied') return t('Keychain access was cancelled. Click Allow when macOS asks to read your browser cookies.')
  if (error === 'devtools-denied') return t('Remote debugging permission was declined in the browser. Try again and click Allow.')
  if (error === 'devtools-timeout') return t('Timed out waiting for you to click Allow in the browser.')
  if (error === 'devtools-wrong-profile') return t('Another browser profile is active. Switch to the chosen profile window in your browser, then try again.')
  return String(error)
}

// The sources popover: installed browser profiles first (most-recent pinned), then file & paste.
export function ImportMenu({ sources, lastSourceId, loading, busy, canPaste, onFile, onPaste, onSource, onClose }) {
  useEscape(onClose)
  return h('div', { className: 'bt-import-menu', role: 'menu', 'aria-label': t('Import cookies') },
    h('div', { className: 'bt-import-menu-title' }, t('Import from browser')),
    loading
      ? h('div', { className: 'bt-import-menu-note' }, t('Loading…'))
      : sources.length === 0
        ? h('div', { className: 'bt-import-menu-note' }, t('No browsers found'))
        : sources.map((source) => {
          const isLast = source.id === lastSourceId
          const isReady = Boolean(source.liveDebugReady)
          const showFallback = !isLast && !isReady && !source.email
          return h('button', {
            key: source.id, type: 'button', className: 'bt-import-item', role: 'menuitem', disabled: busy,
            title: source.email ? `${source.label} (${source.email})` : source.label,
            onClick: () => onSource(source),
          },
            h(WindowIcon, { className: 'bt-import-item-icon' }),
            h('span', { className: 'bt-import-item-main' },
              h('span', { className: 'bt-import-item-name' }, source.label),
              source.email ? h('span', { className: 'bt-import-item-email' }, source.email) : null),
            isLast || isReady || showFallback ? h('span', { className: 'bt-import-item-meta' },
              isLast ? h('span', { className: 'bt-import-item-tag' }, t('Last used')) : null,
              isReady ? h('span', { className: 'bt-import-item-sub', 'data-ready': true }, t('Ready')) : null,
              showFallback ? h('span', { className: 'bt-import-item-sub' }, t('Browser profile')) : null) : null)
        }),
    h('div', { className: 'bt-import-sep', role: 'separator' }),
    h('button', { type: 'button', className: 'bt-import-item', role: 'menuitem', disabled: busy, onClick: onFile },
      h(FileIcon, { className: 'bt-import-item-icon' }),
      h('span', { className: 'bt-import-item-name' }, t('From a file…')),
      h('span', { className: 'bt-import-item-sub' }, t('cookies.txt, JSON, storageState'))),
    canPaste ? h('button', { type: 'button', className: 'bt-import-item', role: 'menuitem', disabled: busy, onClick: onPaste },
      h(PasteIcon, { className: 'bt-import-item-icon' }),
      h('span', { className: 'bt-import-item-name' }, t('Paste cookies or cURL…')),
      h('span', { className: 'bt-import-item-sub' }, t('JSON, cURL, header'))) : null)
}

export function RemoteDebugCard({ flow, busy, imports, onRetrySource, onLaunchSource, onFile, onCancel }) {
  const { source, info } = flow
  const inspectUrl = info?.inspectUrl || 'chrome://inspect/#remote-debugging'
  const browserName = info?.browserName || source.name
  const [copied, setCopied] = useState(false)
  const [detected, setDetected] = useState(false)
  const copyTimerRef = useRef(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      clearTimeout(copyTimerRef.current)
    }
  }, [])

  useEffect(() => {
    const canProbe = typeof imports?.probe === 'function'
    const canList = typeof imports?.sources === 'function'
    if (!canProbe && !canList) return undefined
    let active = true
    let timer = null
    const schedule = () => {
      if (!active) return
      timer = setTimeout(poll, 2000)
    }
    const poll = () => {
      const req = canProbe
        ? imports.probe(source.id).then((res) => Boolean(res?.liveDebugReady))
        : imports.sources().then((list) => Array.isArray(list) && Boolean(list.find((s) => s.id === source.id)?.liveDebugReady))
      void req.then(
        (ready) => { if (active) setDetected(ready) },
        () => {},
      ).finally(schedule)
    }
    schedule()
    return () => { active = false; clearTimeout(timer) }
  }, [imports, source.id])

  const copyAddress = () => {
    void Promise.resolve(writeClipboard(inspectUrl)).then((ok) => {
      if (!ok || !mountedRef.current) return
      setCopied(true)
      clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => {
        if (mountedRef.current) setCopied(false)
      }, 1800)
    }, () => {})
  }

  return h('div', { className: 'bt-import-card' }, h('div', { className: 'bt-import-box' },
    h('div', { className: 'bt-import-title' }, t('Connect to {name}', { name: browserName })),
    h('div', { className: 'bt-import-text' },
      t('{name} protects its cookies on Windows. Enable its built-in remote debugging switch once — no extension needed.', { name: browserName })),
    h('div', { className: 'bt-import-steps' },
      h('div', { className: 'bt-import-step' }, t('1. Open this address in {name}:', { name: browserName })),
      h('div', { className: 'bt-import-copy-row' },
        h('code', { className: 'bt-import-code' }, inspectUrl),
        h('button', { type: 'button', className: 'bt-import-mini', onClick: copyAddress }, copied ? t('Copied') : t('Copy'))),
      h('div', { className: 'bt-import-step' }, t('2. Turn on “Allow remote debugging for this browser instance”, then click Allow when {name} prompts.', { name: browserName }))),
    detected ? h('div', { className: 'bt-import-ready-note' }, t('Remote debugging detected — ready to import.')) : null,
    h('div', { className: 'bt-import-actions' },
      !info?.running && info?.hasExe
        ? h('button', { type: 'button', className: 'bt-import-plain', disabled: busy, onClick: onLaunchSource }, t('Open {name}', { name: browserName }))
        : h('button', { type: 'button', className: 'bt-import-plain', disabled: busy, onClick: onFile }, t('From a file…')),
      h('button', { type: 'button', className: 'bt-import-plain', disabled: busy, onClick: onCancel }, t('Cancel')),
      h('button', { type: 'button', className: 'bt-import-primary', disabled: busy, onClick: onRetrySource }, busy ? t('Connecting…') : t('Connect and import')))))
}

function PasteCard({ flow, busy, onSubmitPaste, onCancel }) {
  const [text, setText] = useState('')
  const [siteUrl, setSiteUrl] = useState(flow.siteUrl || '')
  return h('div', { className: 'bt-import-card' }, h('div', { className: 'bt-import-box' },
    h('div', { className: 'bt-import-title' }, t('Paste cookies or cURL')),
    h('textarea', {
      className: 'bt-import-textarea',
      rows: 5,
      spellCheck: false,
      placeholder: t('Paste Cookie-Editor JSON, Netscape cookies.txt, Copy as cURL, or a Cookie header…'),
      value: text,
      onChange: (event) => setText(event.target.value),
    }),
    h('input', {
      type: 'text',
      className: 'bt-import-input',
      spellCheck: false,
      placeholder: t('Site URL (only needed for plain Cookie headers)'),
      value: siteUrl,
      onChange: (event) => setSiteUrl(event.target.value),
    }),
    h('div', { className: 'bt-import-actions' },
      h('button', { type: 'button', className: 'bt-import-plain', disabled: busy, onClick: onCancel }, t('Cancel')),
      h('button', {
        type: 'button', className: 'bt-import-primary', disabled: busy || !text.trim(),
        onClick: () => onSubmitPaste(text, siteUrl.trim()),
      }, busy ? t('Reading…') : t('Continue')))))
}

export function PreviewCard({ flow, page, busy, onApply, onCancel }) {
  const { preview } = flow
  const sites = (preview.sites ?? []).filter((s) => (s.cookies ?? 0) > 0 || (s.localStorage ?? 0) > 0)
  const currentHost = hostOfUrl(page.url)
  const matchingCurrent = currentHost
    ? sites.filter((s) => siteMatchesHost(s.site, currentHost)).map((s) => s.site)
    : []
  const [selected, setSelected] = useState(() => new Set(sites.map((s) => s.site)))
  const [query, setQuery] = useState('')
  const [persistSession, setPersistSession] = useState(true)

  const hasSession = preview.notes.includes('session-cookies')
  const allSelected = selected.size === sites.length
  const currentOnlySelected = matchingCurrent.length > 0
    && selected.size === matchingCurrent.length
    && matchingCurrent.every((s) => selected.has(s))

  const visibleSites = query.trim()
    ? sites.filter((s) => s.site.toLowerCase().includes(query.trim().toLowerCase()))
    : sites
  const selectedCookies = sites.reduce((sum, s) => sum + (selected.has(s.site) ? s.cookies : 0), 0)
  const selectedStorage = sites.reduce((sum, s) => sum + (selected.has(s.site) ? (s.localStorage ?? 0) : 0), 0)

  const toggleSite = (site) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(site)) next.delete(site)
      else next.add(site)
      return next
    })
  }
  const selectAll = () => setSelected(new Set(sites.map((s) => s.site)))
  const clearAll = () => setSelected(new Set())
  const selectCurrent = () => setSelected(new Set(matchingCurrent))

  const submit = () => {
    const chosen = allSelected ? undefined : [...selected]
    onApply({ sites: chosen, persistSession: hasSession ? persistSession : false })
  }

  return h('div', { className: 'bt-import-card' }, h('div', { className: 'bt-import-box' },
    h('div', { className: 'bt-import-title' }, t('Import {count} cookies', { count: selectedCookies })),
    h('div', { className: 'bt-import-sub' },
      preview.source?.label ?? '',
      flow.restarted ? ` · ${t('the browser was restarted')}` : '',
      selectedStorage > 0 ? ` · ${t('{count} storage entries', { count: selectedStorage })}` : ''),
    matchingCurrent.length > 0 && sites.length > 1 ? h('div', { className: 'bt-import-scope' },
      h('button', {
        type: 'button', className: 'bt-import-pill', 'aria-pressed': allSelected,
        onClick: selectAll,
      }, t('All sites ({count})', { count: sites.length })),
      h('button', {
        type: 'button', className: 'bt-import-pill', 'aria-pressed': currentOnlySelected,
        onClick: selectCurrent,
      }, t('This site ({host})', { host: currentHost }))) : null,
    sites.length > 6 ? h('div', { className: 'bt-import-filter-row' },
      h('input', {
        type: 'text', className: 'bt-import-input', spellCheck: false,
        placeholder: t('Filter sites…'),
        value: query,
        onChange: (event) => setQuery(event.target.value),
      }),
      h('button', {
        type: 'button', className: 'bt-import-mini',
        onClick: allSelected ? clearAll : selectAll,
      }, allSelected ? t('Clear') : t('All'))) : null,
    sites.length ? h('div', { className: 'bt-import-list' },
      visibleSites.map((site) => h('label', { key: site.site, className: 'bt-import-line bt-import-check-row' },
        h('input', {
          type: 'checkbox',
          checked: selected.has(site.site),
          onChange: () => toggleSite(site.site),
        }),
        h('span', { className: 'bt-import-line-name' }, site.site),
        h('span', { className: 'bt-import-line-count' },
          t('{count}', { count: site.cookies }),
          site.localStorage > 0 ? ` · ${t('storage')}` : site.session > 0 ? ` · ${t('{count} session', { count: site.session })}` : '')))) : null,
    preview.skipped.length ? h('div', { className: 'bt-import-list' },
      h('div', { className: 'bt-import-note' }, t('{count} skipped', { count: preview.skipped.length })),
      preview.skipped.slice(0, 5).map((item, index) => h('div', { key: index, className: 'bt-import-line' },
        h('span', { className: 'bt-import-line-name' }, item.name ?? item.where),
        h('span', { className: 'bt-import-line-reason' }, item.reason))),
      preview.skipped.length > 5 ? h('div', { className: 'bt-import-line' }, h('span', { className: 'bt-import-line-reason' }, t('and {count} more', { count: preview.skipped.length - 5 }))) : null) : null,
    preview.warnings.length ? h('details', { className: 'bt-import-warns' },
      h('summary', null, t('{count} adjusted', { count: preview.warnings.reduce((n, w) => n + w.count, 0) })),
      preview.warnings.map((w, index) => h('div', { key: index, className: 'bt-import-line' },
        h('span', { className: 'bt-import-line-reason' }, `${w.count} × ${w.message}`)))) : null,
    hasSession ? h('label', { className: 'bt-import-toggle' },
      h('input', { type: 'checkbox', checked: persistSession, onChange: (event) => setPersistSession(event.target.checked) }),
      h('span', null, t('Keep session logins after app restart'))) : null,
    preview.notes.includes('local-storage-left') ? h('div', { className: 'bt-import-note' }, t('Some sites also keep sign-in outside cookies; you may need to sign in again there.')) : null,
    h('div', { className: 'bt-import-actions' },
      h('button', { type: 'button', className: 'bt-import-plain', disabled: busy, onClick: onCancel }, t('Cancel')),
      h('button', { type: 'button', className: 'bt-import-primary', disabled: busy || (selectedCookies === 0 && selectedStorage === 0), onClick: submit }, busy ? t('Importing…') : t('Import')))))
}

// The card that runs an import: connecting / remote-debug / running / paste → preview → result | error.
function ImportCard({ flow, page, busy, imports, onApply, onCancel, onCloseAndImport, onRetrySource, onLaunchSource, onFile, onSubmitPaste, onDone, onReload }) {
  const { stage } = flow
  if (stage === 'connecting') {
    return h('div', { className: 'bt-import-card' }, h('div', { className: 'bt-import-box' },
      h('div', { className: 'bt-import-title' }, t('Reading {name}…', { name: flow.source.name })),
      h('div', { className: 'bt-import-sub' }, flow.source.label),
      h('div', { className: 'bt-import-text' }, t('If {name} or your system asks for permission, click Allow.', { name: flow.source.name })),
      h('div', { className: 'bt-import-actions' },
        h('button', { type: 'button', className: 'bt-import-plain', onClick: onCancel }, t('Cancel')))))
  }
  if (stage === 'remote-debug') {
    return h(RemoteDebugCard, { flow, busy, imports, onRetrySource, onLaunchSource, onFile, onCancel })
  }
  if (stage === 'paste') {
    return h(PasteCard, { flow, busy, onSubmitPaste, onCancel })
  }
  if (stage === 'running') {
    return h('div', { className: 'bt-import-card' }, h('div', { className: 'bt-import-box' },
      h('div', { className: 'bt-import-title' }, t('{name} is running', { name: flow.source.name })),
      h('div', { className: 'bt-import-text' }, t('It must close for a moment so its cookies can be copied. It will reopen with your tabs.')),
      h('div', { className: 'bt-import-actions' },
        h('button', { type: 'button', className: 'bt-import-plain', disabled: busy, onClick: onCancel }, t('Cancel')),
        h('button', { type: 'button', className: 'bt-import-primary', disabled: busy, onClick: onCloseAndImport }, busy ? t('Closing…') : t('Close {name} and import', { name: flow.source.name })))))
  }
  if (stage === 'error') {
    return h('div', { className: 'bt-import-card' }, h('div', { className: 'bt-import-box' },
      h('div', { className: 'bt-import-title' }, t('Import failed')),
      h('div', { className: 'bt-import-text' }, flow.message),
      h('div', { className: 'bt-import-actions' }, h('button', { type: 'button', className: 'bt-import-plain', onClick: onCancel }, t('Close')))))
  }
  if (stage === 'result') {
    const { report } = flow
    const problems = [...(report.dropped ?? []), ...(report.failed ?? [])]
    const title = report.stored > 0
      ? t('Imported {count} cookies', { count: report.stored })
      : (report.originsStored ?? 0) > 0
        ? t('Imported storage for {count} sites', { count: report.originsStored })
        : t('No cookies were stored')
    return h('div', { className: 'bt-import-card' }, h('div', { className: 'bt-import-box' },
      h('div', { className: 'bt-import-title' }, title),
      h('div', { className: 'bt-import-sub' },
        [
          flow.label,
          (report.originsStored ?? 0) > 0 ? t('{count} sites storage', { count: report.originsStored }) : null,
          flow.reloaded ? t('page reloaded') : null,
        ].filter(Boolean).join(' · ')),
      problems.length ? h('div', { className: 'bt-import-list' },
        problems.slice(0, 8).map((item, index) => h('div', { key: index, className: 'bt-import-line' },
          h('span', { className: 'bt-import-line-name' }, item.name ?? '—'),
          h('span', { className: 'bt-import-line-reason' }, item.reason))),
        problems.length > 8 ? h('div', { className: 'bt-import-line' }, h('span', { className: 'bt-import-line-reason' }, t('and {count} more', { count: problems.length - 8 }))) : null) : null,
      h('div', { className: 'bt-import-actions' },
        page.url && !flow.reloaded ? h('button', { type: 'button', className: 'bt-import-plain', onClick: onReload }, t('Reload the page')) : null,
        h('button', { type: 'button', className: 'bt-import-primary', onClick: onDone }, t('Done')))))
  }
  return h(PreviewCard, { key: flow.id, flow, page, busy, onApply, onCancel })
}

/**
 * One aside for the Bot's details, browser and side chats. `pane` is
 * `{ id, view: 'details'|'browser'|'side', renaming, tab, side }`; `id` is the
 * Session id the panel follows and `side` the open chat's id. Without the
 * Desktop bridge the browser view never shows; side chats need no bridge.
 */
export function BotPanel({ pane, leaving, room, overlay, roster, actions, useSessions, useSessionStatus, useActivity, useWork, useBrowserTabs, useBrowserPages, useBrowserHolds, useComputer }) {
  const bot = roster.byId[pane.id]
  const roomSubject = roster.roomsById?.[pane.id]
  const canBrowse = Boolean(bot && roster.browser === true && actions.browserShow)
  const sideChats = bot ? sideChatsOf(roster, bot.id) : []
  const sideChat = sideChats.find(chat => chat?.id === pane.side)
  const taskBot = pane.task?.botId ? roster.byId?.[pane.task.botId] : undefined
  const taskEntry = taskBot && pane.task?.taskId ? (taskBot.tasks ?? []).find(item => item?.id === pane.task.taskId) : undefined
  const view = pane.view === 'browser' && canBrowse ? 'browser'
    : pane.view === 'side' && sideChat !== undefined ? 'side'
      : pane.view === 'task' && taskEntry !== undefined ? 'task'
        : 'details'
  const tabState = useBrowserTabs(map => (bot ? (map[bot.id] ?? EMPTY_TABS) : EMPTY_TABS))
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

  const panelWidth = fitWidth(width ?? (view === 'browser' ? DEFAULT_WIDTH : DETAILS_WIDTH), widthRange(view, room))
  // Once the browser has shown, the Bot page keeps its width (up to DETAILS_MAX).
  useLayoutEffect(() => { if (view === 'browser' && width === null) setWidth(DEFAULT_WIDTH) }, [view, width])
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
  useEscape(() => actions.closeOverlay(), !leaving, { priority: -1 })
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

  // A Bot's strip restores as soon as the panel opens for it.
  useEffect(() => { if (canBrowse) actions.browserEnsure(bot.id) }, [bot?.id, canBrowse])
  // With the last tab closed the browser view folds back into the details view.
  useEffect(() => {
    if (view === 'browser' && (active === null || !tabState.ids.includes(active))) actions.setPanelView('details')
  }, [view, active, tabState.ids.length])
  // A side chat closed here or in another window folds back into details too.
  useEffect(() => {
    if (pane.view === 'side' && sideChat === undefined) actions.setPanelView('details')
  }, [pane.view, sideChat])
  useEffect(() => {
    if (pane.view === 'task' && taskEntry === undefined) actions.closeTask?.()
  }, [pane.view, taskEntry])
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
    const outgoing = panel.querySelector(':scope > .bt-panel-view')
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
      plan, next, id: pane.id, at: performance.now(), end: flightEnd(next),
      node: source ? uniqueIds(source.cloneNode(true)) : null, from: source ? source.getBoundingClientRect() : null,
    }
  }
  const switchView = (next) => {
    if (next === view || leaving) return
    beginSwitch(next)
    actions.setPanelView(next)
  }
  // Every path into the browser view (globe, card, +) animates the same collapse.
  const panelActions = { ...actions }
  for (const name of ['openBrowser', 'browserNewTab', 'browserPick']) {
    if (actions[name]) panelActions[name] = (...args) => { if (view !== 'browser') beginSwitch('browser'); return actions[name](...args) }
  }
  for (const name of ['openSideChat', 'newSideChat']) {
    if (actions[name]) panelActions[name] = (...args) => { if (view !== 'side') beginSwitch('side'); return actions[name](...args) }
  }
  // The note is good for the one switch it was made for. A view change without a note
  // (a closed tab folding the panel back, say) or after the note went stale ends the flight:
  // its target is no longer what it flew for.
  useLayoutEffect(() => {
    const note = intent.current
    intent.current = null
    const current = note !== null && note.next === view && note.id === pane.id && performance.now() - note.at < INTENT_MS && !instant && !leaving && !reducedMotion()
    if (!current) { flight.finish(); return }
    if (note.plan === 'keep') return
    if (note.plan === 'reverse') { if (!flight.retarget(note.end)) flight.finish(); return }
    flight.begin({ panel: root.current, end: note.end, node: note.node, from: note.from })
  }, [view, pane.id])
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

  const hasStrip = panelHasStrip(canBrowse, tabState.ids.length, sideChats.length, taskEntry !== undefined)
  return h('aside', {
    ref: root, className: 'bt-panel', 'data-view': view,
    'aria-label': view === 'browser' && bot ? t("{name}'s browser", { name: bot.name }) : view === 'side' ? t('Side chat') : view === 'task' && taskEntry ? taskEntry.title : t('Conversation details'),
    'data-leaving': leaving || undefined, 'aria-hidden': leaving || undefined, 'data-settling': settling || undefined,
    'data-instant': instant || undefined, 'data-dragging': dragging || undefined, 'data-overlay': overlay || undefined, style: { '--bt-panel-w': `${panelWidth}px` },
    onAnimationEnd: (event) => { if (event.target === event.currentTarget) setLanded(true) },
  },
    leaving || overlay ? null : h('div', { className: 'bt-panel-grip', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': t('Resize panel'), onPointerDown: startResize }),
    // Over the whole window while dragging: the cursor stays a resize cursor and the
    // pages underneath (the chat, the guest) see no pointer.
    dragging ? createPortal(h('div', { className: 'bt-drag-shield', 'aria-hidden': true }), document.body) : null,
    hasStrip ? h(PanelStrip, { bot, roomSubject, subject: pane.id, view, ids: tabState.ids, active, sides: sideChats, side: pane.side, task: taskEntry, canBrowse, reading, onView: switchView, actions: panelActions, useBrowserPages }) : null,
    view === 'browser' && bot
      ? h(BrowserView, { key: `browser:${active}`, bot, tabId: active, leaving, landed: landed && !settling, actions, useBrowserPages, hold })
      : view === 'side' && sideChat
        ? h('div', { key: `side:${sideChat.id}`, className: 'bt-panel-view' }, h(SideChatView, { subject: pane.id, chat: sideChat, roster, actions: panelActions }))
        : view === 'task' && taskEntry && taskBot
          ? h('div', { key: `task:${taskEntry.id}`, className: 'bt-panel-view' }, h(TaskReaderView, { bot: taskBot, task: taskEntry, actions: panelActions }))
          : h('div', { key: `details:${pane.id}:${pane.renaming ? 'rename' : ''}:${pane.tab ?? ''}`, className: 'bt-panel-view' },
              h(DetailsDrawer, {
                sessionId: pane.id, startRenaming: pane.renaming, startTab: pane.tab, hasStrip,
                roster, actions: panelActions, useSessions, useSessionStatus, useActivity, useWork, useBrowserTabs, useBrowserPages, useComputer,
              })))
}

export const BROWSER_CSS = `
.bt-panel{--bt-panel-view-fade:${SPRING_SHAPE.duration}ms}
.bt-ptabs{position:relative;display:flex;align-items:center;height:44px;flex:none;border-bottom:.5px solid var(--bt-line);padding:0 6px;gap:0;animation:bt-strip-in ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing}}
@keyframes bt-strip-in{from{height:0;opacity:0}}
.bt-ptabs-in{position:relative;display:flex;align-items:center;gap:2px;flex:1;min-width:0;height:100%;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;padding:4px 2px;scroll-padding-left:48px;mask-image:linear-gradient(to right,#000,#000 calc(100% - 10px),transparent)}
.bt-ptabs-in>.bt-ptab-bot{position:sticky;left:0;z-index:2;background:var(--bt-main)}
.bt-ptabs-in>.bt-ptab-bot[aria-selected=true]{background:transparent}
.bt-ptabs-in::-webkit-scrollbar{display:none}
.bt-ptab-wrap{position:relative;z-index:1;display:inline-flex;align-items:center;height:32px;max-width:180px;flex:none;border-radius:8px;padding-right:4px}
.bt-ptab{position:relative;z-index:1;display:inline-flex;align-items:center;gap:6px;height:32px;max-width:180px;padding:0 8px;flex:none;border:0;border-radius:8px;background:none;color:var(--bt-ink-2);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap;transition:color .12s ease}
.bt-ptab-btn{max-width:none;min-width:0;flex:1 1 auto;padding:0 4px 0 8px}
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
.bt-ptab-new{position:relative;z-index:1;flex:none;width:28px;height:32px;border:0;border-radius:8px;background:none;color:var(--bt-ink-3);display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
.bt-ptab-new:hover{color:var(--bt-ink)}
.bt-ptab-new svg{width:15px;height:15px}
.bt-ptab-ind{position:absolute;top:4px;bottom:4px;border-radius:8px;background:var(--bt-hover);opacity:0;pointer-events:none;z-index:0;transition:opacity .15s ease}
.bt-ptab-close{flex:none;margin-left:2px}
.bt-panel-ghost{position:absolute;right:0;overflow:hidden;pointer-events:none;z-index:2}
.bt-panel-ghost>.bt-panel-view{position:absolute;inset:0}
.bt-panel-view{flex:1;min-height:0;display:flex;flex-direction:column;animation:bt-panel-view-in .22s cubic-bezier(.16,1,.3,1)}
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
.bt-import-menu{position:absolute;top:6px;right:6px;z-index:6;width:312px;max-width:calc(100% - 12px);max-height:min(360px,calc(100% - 12px));overflow:auto;padding:6px;border-radius:16px;background:var(--bt-glass-bg);-webkit-backdrop-filter:blur(24px) saturate(180%);backdrop-filter:blur(24px) saturate(180%);border:.5px solid var(--bt-glass-rim);box-shadow:var(--bt-glass-shadow);transform-origin:top right;animation:bt-pop-drop .18s cubic-bezier(.16,1,.3,1),bt-fade .14s ease-out}
.bt-import-menu-title{padding:6px 10px 8px;font-size:11px;font-weight:500;letter-spacing:.02em;color:var(--bt-ink-3)}
.bt-import-sep{height:.5px;margin:4px 8px;background:var(--bt-line)}
.bt-import-item{display:flex;align-items:center;gap:9px;width:100%;min-width:0;padding:8px 10px;border:0;border-radius:8px;background:none;color:var(--bt-ink);font:inherit;font-size:12px;text-align:left;cursor:pointer}
.bt-import-item:hover{background:var(--bt-hover)}
.bt-import-item:disabled{opacity:.5;cursor:default}
.bt-import-item-icon,.bt-import-item svg{flex:none;color:var(--bt-ink-3)}
.bt-import-item-icon svg,.bt-import-item svg{width:15px;height:15px}
.bt-import-item-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.bt-import-item-name{flex:none;max-width:62%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-import-item-main .bt-import-item-name{max-width:none}
.bt-import-item-email{font-size:11px;line-height:15px;color:var(--bt-ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-import-item-meta{flex:none;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.bt-import-item-tag{font-size:11px;color:var(--bt-ink-3)}
.bt-import-item-sub{flex:1;min-width:0;text-align:right;font-size:11px;color:var(--bt-ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-import-item-meta .bt-import-item-sub{flex:none}
.bt-import-item-sub[data-ready]{color:var(--bt-green);font-weight:500}
.bt-import-menu-note{padding:8px 10px 10px;font-size:12px;color:var(--bt-ink-3)}
.bt-import-card{position:absolute;inset:0;z-index:5;display:flex;align-items:center;justify-content:center;padding:20px;background:var(--bt-main);overflow:auto;animation:bt-foot-in .2s ease}
.bt-import-box{width:100%;max-width:380px;max-height:100%;display:flex;flex-direction:column;gap:10px;padding:20px;border:.5px solid var(--bt-line-2);border-radius:16px;background:var(--bt-main);box-shadow:0 12px 36px -12px rgba(0,0,0,.14);overflow:auto}
.bt-import-title{font-size:15px;line-height:21px;font-weight:600}
.bt-import-sub{font-size:12px;line-height:17px;color:var(--bt-ink-3);margin-top:-6px}
.bt-import-text{font-size:13px;line-height:19px;color:var(--bt-ink-2);overflow-wrap:anywhere}
.bt-import-steps{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-radius:10px;background:var(--bt-hover)}
.bt-import-step{font-size:12px;line-height:17px;color:var(--bt-ink-2)}
.bt-import-copy-row{display:flex;align-items:center;gap:6px;min-width:0}
.bt-import-code{flex:1;min-width:0;padding:5px 8px;border-radius:6px;border:.5px solid var(--bt-line);background:var(--bt-main);color:var(--bt-ink);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;user-select:all}
.bt-import-mini{flex:none;height:28px;padding:0 10px;border:.5px solid var(--bt-line-2);border-radius:8px;background:var(--bt-main);color:var(--bt-ink);font:inherit;font-size:12px;cursor:pointer}
.bt-import-mini:hover{background:var(--bt-hover)}
.bt-import-ready-note{font-size:12px;line-height:17px;font-weight:500;color:var(--bt-green)}
.bt-import-textarea{width:100%;box-sizing:border-box;min-height:96px;max-height:200px;resize:vertical;padding:8px 10px;border:.5px solid var(--bt-line-2);border-radius:10px;background:var(--bt-main);color:var(--bt-ink);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:16px;outline:none}
.bt-import-input{width:100%;box-sizing:border-box;height:30px;padding:0 10px;border:.5px solid var(--bt-line-2);border-radius:8px;background:var(--bt-main);color:var(--bt-ink);font:inherit;font-size:12px;outline:none}
.bt-import-textarea:focus,.bt-import-input:focus{border-color:var(--bt-accent)}
.bt-import-input::placeholder,.bt-import-textarea::placeholder{color:var(--bt-ink-3)}
.bt-import-scope{display:flex;gap:6px;flex-wrap:wrap}
.bt-import-pill{height:26px;max-width:100%;padding:0 10px;border:.5px solid var(--bt-line-2);border-radius:999px;background:var(--bt-main);color:var(--bt-ink-2);font:inherit;font-size:12px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-import-pill:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bt-import-pill[aria-pressed=true]{border-color:var(--bt-accent);background:var(--bt-accent-soft);color:var(--bt-ink);font-weight:500}
.bt-import-filter-row{display:flex;align-items:center;gap:6px}
.bt-import-filter-row .bt-import-input{flex:1;min-width:0;height:28px}
.bt-import-list{max-height:180px;overflow:auto;border:.5px solid var(--bt-line);border-radius:10px;padding:4px 10px}
.bt-import-line{display:flex;align-items:baseline;gap:8px;padding:4px 0;min-width:0}
.bt-import-check-row{align-items:center;cursor:pointer}
.bt-import-check-row input[type=checkbox]{flex:none;margin:0;accent-color:var(--bt-accent);cursor:pointer}
.bt-import-line-name{flex:none;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--bt-ink)}
.bt-import-line-count{flex:1;min-width:0;text-align:right;font-size:11px;color:var(--bt-ink-3);white-space:nowrap}
.bt-import-line-reason{flex:1;min-width:0;font-size:11px;line-height:16px;color:var(--bt-ink-3);overflow-wrap:anywhere}
.bt-import-toggle{display:flex;align-items:center;gap:8px;font-size:12px;line-height:17px;color:var(--bt-ink-2);cursor:pointer;user-select:none}
.bt-import-toggle input[type=checkbox]{flex:none;margin:0;accent-color:var(--bt-accent);cursor:pointer}
.bt-import-note{font-size:12px;line-height:17px;color:var(--bt-ink-3)}
.bt-import-warns{font-size:12px;color:var(--bt-ink-3)}
.bt-import-warns summary{cursor:pointer;padding:2px 0}
.bt-import-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:4px}
.bt-import-primary{height:32px;padding:0 16px;border:0;border-radius:999px;background:var(--bt-accent);color:var(--bt-accent-ink);font:inherit;font-size:13px;cursor:pointer}
.bt-import-primary:disabled{opacity:.55;cursor:default}
.bt-import-plain{height:32px;padding:0 14px;border:.5px solid var(--bt-line-2);border-radius:999px;background:var(--bt-main);color:var(--bt-ink);font:inherit;font-size:13px;cursor:pointer}
.bt-import-plain:hover{background:var(--bt-hover)}
.bt-import-plain:disabled{opacity:.55;cursor:default}
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
