// The Bot shell's frame geometry: the left column (open, avatar rail, drawer or
// hidden), the Bot panel and the conversation share the window. The conversation
// keeps at least MIN_CHAT px; the column folds to a rail of avatars before the
// chat is squeezed, and an open panel that no longer fits folds away or covers
// the chat. These rules are pure so tests can drive them; the DOM side lives in
// frame-watch.js.
import { STORAGE } from './storage.js'

export const MIN_CHAT = 420
export const RAIL_WIDTH = 88
export const PANEL_MIN = { details: 320, browser: 360, side: 320 }
// The shell collapses its own sidebar below this width.
export const DSH_NARROW = 1024
// The open column's width range; a drag released short of RAIL_SNAP lands on the rail.
export const SIDEBAR_MIN = 264
export const SIDEBAR_MAX = 420
export const FALLBACK_SIDEBAR_WIDTH = 280
export const RAIL_SNAP = (RAIL_WIDTH + SIDEBAR_MIN) / 2

/**
 * @param {{viewport: number, sidebarWidth: number,
 *   pref: 'open'|'rail'|'hidden', drawer?: boolean,
 *   panel: null | {view: string, yielded: boolean}}} input
 * @returns {{left: 'open'|'rail'|'drawer'|'hidden', panel: 'none'|'shown'|'folded'|'overlay', room: number}}
 *   `room` is the width the panel and the conversation share: the viewport minus
 *   what the left column occupies (its full width when open, nothing when hidden,
 *   else the rail's — a drawer floats over the rail's place, so the chat does not
 *   move under it).
 */
export function frameLayout({ viewport, sidebarWidth, pref, drawer = false, panel = null }) {
  const fits = pref === 'open' && viewport >= sidebarWidth + MIN_CHAT
  let left = pref === 'hidden' ? 'hidden' : fits ? 'open' : drawer && pref === 'open' ? 'drawer' : 'rail'
  let occupied = left === 'open' ? sidebarWidth : left === 'hidden' ? 0 : RAIL_WIDTH
  let panelState = 'none'
  if (panel !== null) {
    const need = (PANEL_MIN[panel.view] ?? PANEL_MIN.details) + MIN_CHAT
    if (occupied + need <= viewport) panelState = 'shown'
    else if (panel.yielded === true) {
      // A panel the user asks to see takes the column's room: it falls back to
      // the rail, and covers the conversation only when even that is not enough.
      if (left !== 'hidden') { left = 'rail'; occupied = RAIL_WIDTH }
      panelState = occupied + need <= viewport ? 'shown' : 'overlay'
    } else panelState = 'folded'
  }
  return { left, panel: panelState, room: Math.max(0, viewport - occupied) }
}

/**
 * Where a drag of the column's edge to `x` lands: short of RAIL_SNAP the rail;
 * past it an open column of that width, docked while the chat keeps MIN_CHAT
 * beside it, else floating as a drawer.
 * @returns {{left: 'rail'|'open'|'drawer', width: number}}
 */
export function dragColumn(x, viewport) {
  if (x < RAIL_SNAP) return { left: 'rail', width: RAIL_WIDTH }
  const docks = viewport >= SIDEBAR_MIN + MIN_CHAT
  const high = docks ? Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, viewport - MIN_CHAT)) : SIDEBAR_MAX
  return { left: docks ? 'open' : 'drawer', width: Math.round(Math.max(SIDEBAR_MIN, Math.min(x, high))) }
}

// The top-left switch hides the whole column and brings back the one it hid.
export const toggledPref = (pref, shown) => (pref === 'hidden' ? shown : 'hidden')

// The shell measures the window on its own frame, a beat apart from us, and
// re-applies its own rule when it does: a flip this soon after a width change is
// the shell settling, not a gesture.
export const RESIZE_SETTLE_MS = 500
// A flip of the shell's collapsed flag counts as the user's own switch gesture
// only when we did not request it, the width has settled, and it stayed on one
// side of the auto-collapse line (a crossing is the shell's own rule firing).
export const userSidebarToggle = ({ before, after, requested = false, sinceResize = Infinity }) =>
  before.collapsed !== after.collapsed && !requested && sinceResize >= RESIZE_SETTLE_MS
  && (before.viewport < DSH_NARROW) === (after.viewport < DSH_NARROW)

// The user's column survives restarts: `pref` is 'open' by default, 'rail' after
// a drag down to it, 'hidden' after the switch; `shown` is what the switch brings
// back; `width` is the open column's.
const PREFS = ['open', 'rail', 'hidden']
export function readSidebar(storage = globalThis.localStorage) {
  try {
    const saved = JSON.parse(storage.getItem(STORAGE.sidebar) ?? 'null')
    const pref = PREFS.includes(saved?.pref) ? saved.pref : 'open'
    const shown = saved?.shown === 'rail' ? 'rail' : 'open'
    const width = Number.isFinite(saved?.width) ? Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, saved.width)) : FALLBACK_SIDEBAR_WIDTH
    return { pref, shown, width }
  } catch { return { pref: 'open', shown: 'open', width: FALLBACK_SIDEBAR_WIDTH } }
}
export function writeSidebar(value, storage = globalThis.localStorage) {
  try { storage.setItem(STORAGE.sidebar, JSON.stringify(value)) } catch { /* storage unavailable */ }
}
