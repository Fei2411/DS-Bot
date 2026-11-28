// Shared center-column layout rule for both desktop and plugin modes.
// Desktop renders `data-bt-center` directly on `<main class="dsb-main">`;
// plugin mode stamps `data-bt-center` onto DSH's center column via `adapter-dsh.js`.
import { installStyles } from './styles.js'

let hostCollapsedReader = null

export function registerHostCollapsed(reader) {
  hostCollapsedReader = typeof reader === 'function' ? reader : null
  return () => {
    if (hostCollapsedReader === reader) hostCollapsedReader = null
  }
}

export function dshCollapsed() {
  return hostCollapsedReader ? hostCollapsedReader() : null
}

const room = { rule: null }
const roomRule = () => {
  const live = room.rule?.parentStyleSheet?.ownerNode?.isConnected
  if (live) return room.rule
  const declarations = room.rule?.style.cssText ?? ''
  room.rule?.parentStyleSheet?.ownerNode?.remove()
  const style = installStyles(`[data-bt-center]{${declarations}}`, 'chat-room')
  room.rule = style.sheet.cssRules[0]
  return room.rule
}

const margin = (side, width, style) => {
  if (width === null) style.removeProperty(`margin-${side}`)
  else style.setProperty(`margin-${side}`, `${width}px`, 'important')
  // A host skin can give the grid item width:100%. That width plus our margins
  // exceeds its track. Own the width until both margin overrides are released,
  // including an explicit zero used while our column is hidden.
  if (style.marginLeft || style.marginRight) style.setProperty('width', 'auto', 'important')
  else style.removeProperty('width')
}

let roomHold = 0
export const chatRoom = {
  /** The margin the Bot panel takes on the right, in px, or null for the shell's own. */
  setRight(width) { margin('right', width, roomRule().style) },
  /** The margin our own left column takes while the shell sidebar is collapsed. */
  setLeft(width) { margin('left', width, roomRule().style) },
  /** While on, a margin change lands at once instead of gliding. */
  hold(on) {
    cancelAnimationFrame(roomHold)
    if (on) { roomRule().style.setProperty('transition', 'none', 'important'); return }
    // Two frames, so the last held write is on screen before the glide comes back.
    roomHold = requestAnimationFrame(() => { roomHold = requestAnimationFrame(() => roomRule().style.removeProperty('transition')) })
  },
  /** The columns themselves, for a drag's per-frame writes. */
  columns() {
    roomRule()
    return [...document.querySelectorAll('[data-bt-center]')]
  },
}
