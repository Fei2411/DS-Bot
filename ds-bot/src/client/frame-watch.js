// The DOM side of the frame layout in frame-layout.js: measuring the shell's
// sidebar track in DSH plugin mode. Shared center-column layout lives in `chat-room.js`.
import { nextCollapsedWidth, trackRoom } from './frame-layout.js'
import { chatRoom, registerHostCollapsed } from './chat-room.js'

export { chatRoom }

export const sidebarTrackWidth = (column = typeof document === 'undefined' ? null : document.querySelector('[class*="_sidebarCol"]')) => {
  if (!column) return null
  const position = typeof getComputedStyle === 'function' ? getComputedStyle(column).position : ''
  // A drawer overlays the grid; its visible strip does not reserve a track.
  if (position === 'absolute' || position === 'fixed') return 0
  return trackRoom(column.getBoundingClientRect())
}

// The shell frame marks itself [data-sidebar-collapsed]; null when no frame is found.
export const dshCollapsed = (column = typeof document === 'undefined' ? null : document.querySelector('[class*="_sidebarCol"]')) => {
  if (typeof document === 'undefined') return null
  return column ? column.closest('[data-sidebar-collapsed]') !== null : null
}

// The track the collapsed shell sidebar keeps: nothing under a frameless window
// (Windows title bar, macOS desktop), its icon rail elsewhere.
export const collapsedTrackWidth = () =>
  document.documentElement.hasAttribute('data-windows-titlebar') || document.documentElement.dataset.platform === 'darwin' ? 0 : 56

// Feeds the frame source the geometry the layout rules read: viewport, the
// shell sidebar's collapsed track width, and its collapsed flag. A resize or a
// sidebar slide does not always come with a window event, so the track width
// comes off a ResizeObserver and the flag off a MutationObserver.
const COLUMNS = '[class*="_sidebarCol"],[class*="_centerCol"]'

export function installFrameWatch(frame) {
  const offCollapsed = registerHostCollapsed(() => dshCollapsed())
  let collapsedWidth = collapsedTrackWidth()
  let raf = 0
  const watched = new Set()
  let sidebarColumn = null
  let scanned = false
  let added = false
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => schedule()) : null
  const read = () => {
    // While the shell slides its sidebar (data-animating on the frame) the
    // track reports in-between widths: keep the last settled ones. The viewport
    // and the collapsed flag still update; the observer refires when the flag
    // clears, so the settled width lands then.
    const column = sidebarColumn?.isConnected ? sidebarColumn : (sidebarColumn = document.querySelector('[class*="_sidebarCol"]'))
    const animating = column?.closest('[data-animating]') != null
    const width = animating ? null : sidebarTrackWidth(column)
    const collapsed = dshCollapsed(column)
    collapsedWidth = nextCollapsedWidth({ measured: width, collapsed, animating, last: collapsedWidth })
    frame.set((state) => {
      const next = { ...state, viewport: window.innerWidth, collapsedWidth, collapsed: collapsed === true }
      return state.viewport === next.viewport && state.collapsedWidth === next.collapsedWidth && state.collapsed === next.collapsed ? state : next
    })
  }
  // Scanning a long chat's DOM for the columns costs more than the read, so the
  // scan runs once on mount, when a watched column disconnects, or when a
  // mutation added a matching column (even when the shell only mounts 0 or 1).
  const measure = () => {
    let scan = !scanned || added
    added = false
    for (const column of watched) {
      if (!column.isConnected) {
        watched.delete(column)
        observer?.unobserve(column)
        if (column === sidebarColumn) sidebarColumn = null
        scan = true
      }
    }
    if (scan) {
      scanned = true
      for (const column of document.querySelectorAll(COLUMNS)) {
        if (!watched.has(column)) { watched.add(column); observer?.observe(column) }
        if (column.matches?.('[class*="_centerCol"]') && !column.hasAttribute('data-bt-center')) {
          column.setAttribute('data-bt-center', '')
        }
        if (!sidebarColumn?.isConnected && column.matches?.('[class*="_sidebarCol"]')) sidebarColumn = column
      }
    }
    read()
  }
  const schedule = () => {
    if (raf === 0) raf = requestAnimationFrame(() => { raf = 0; measure() })
  }
  const addsColumn = (record) => [...record.addedNodes].some(node => node?.nodeType === 1 && (node.matches?.(COLUMNS) || node.querySelector?.(COLUMNS) !== null))
  const relevant = (records) => {
    let hit = false
    for (const record of records) {
      if (record.type === 'attributes') { hit = true; continue }
      const target = record.target
      if (target?.nodeType === 1 && target.closest?.('[data-chat-flow],[data-composer-card]')) continue
      hit = true
      if (!added && addsColumn(record)) added = true
    }
    return hit
  }
  measure()
  const mutations = new MutationObserver((records) => { if (relevant(records)) schedule() })
  mutations.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-sidebar-collapsed', 'data-animating'] })
  window.addEventListener('resize', schedule)
  return () => {
    offCollapsed()
    cancelAnimationFrame(raf)
    mutations.disconnect()
    observer?.disconnect()
    window.removeEventListener('resize', schedule)
  }
}
