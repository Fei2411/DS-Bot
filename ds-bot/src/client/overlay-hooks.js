import { useEffect, useRef } from 'react'

// -------------------------------------------------------------------------
// Overlays: new chat, bot exchange, details drawer, context menu

// Escape closes only the newest open layer at the highest priority, so a dialog,
// menu, or inline editor over the details pane does not take the pane down with it.
export const ESCAPE_PRIORITY = {
  PANEL: -1,
  DRAWER: 0,
  DIALOG: 0,
  TOUR: 5,
  PALETTE: 10,
  INLINE_ACTION: 12,
  MENU: 15,
  SHORTCUTS: 20,
  MODAL_CHILD: 30,
  SELECT_MENU: 35,
  LIGHTBOX: 40,
  RECORDING: 100,
}

export const CAPTURE_ESCAPE_MIN_PRIORITY = ESCAPE_PRIORITY.INLINE_ACTION

const escapeLayers = []
export function hasEscapeLayer() {
  return escapeLayers.length > 0
}

// True when Settings owns the active keyboard modal layer (not covered by another
// non-leaving modal dialog such as ShortcutsDialog, PresetModal, or a DSH modal).
export function settingsOwnsKeyboard(dialog, doc = typeof document === 'undefined' ? null : document) {
  if (dialog && dialog.isConnected === false) return false
  if (!doc || typeof doc.querySelectorAll !== 'function') return true
  for (const modal of doc.querySelectorAll('[aria-modal="true"], [role="alertdialog"]')) {
    if (modal === dialog) continue
    if (typeof modal.closest === 'function' && modal.closest('[data-leaving]')) continue
    return false
  }
  return true
}
const topEscapeLayer = () => {
  let top = null
  for (const layer of escapeLayers) {
    if (top === null || layer.priority >= top.priority) top = layer
  }
  return top
}
export function topEscapePriority() {
  const top = topEscapeLayer()
  return top === null ? -Infinity : top.priority
}
const isEscapeEvent = (event) => !event.defaultPrevented && event.key === 'Escape' && !event.isComposing && event.keyCode !== 229

// Transient menus, popovers, selects, shortcuts, lightboxes, and shortcut recording
// handle Escape during `document` capture so they run BEFORE DSH's `Modal` (`useModalLayer`
// listens on `document` bubble in plugin mode). Lower dialog/tour/panel layers stay on
// `window` bubble so a DSH `Modal` or `Menu` opened above Settings still closes first.
const onCaptureEscapeKey = (event) => {
  if (!isEscapeEvent(event)) return
  const top = topEscapeLayer()
  if (!top || top.priority < CAPTURE_ESCAPE_MIN_PRIORITY) return
  event.preventDefault?.()
  event.stopPropagation?.()
  top.ref.current()
}
const onBubbleEscapeKey = (event) => {
  if (!isEscapeEvent(event)) return
  const top = topEscapeLayer()
  if (!top) return
  event.preventDefault?.()
  event.stopPropagation?.()
  top.ref.current()
}
let listening = false
let captureTarget = null
const attachEscapeListeners = () => {
  if (listening) return
  listening = true
  captureTarget = typeof document !== 'undefined' && typeof document.addEventListener === 'function' ? document : null
  if (captureTarget) captureTarget.addEventListener('keydown', onCaptureEscapeKey, true)
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('keydown', onBubbleEscapeKey, false)
  }
}
const detachEscapeListeners = () => {
  if (!listening) return
  listening = false
  if (captureTarget) captureTarget.removeEventListener('keydown', onCaptureEscapeKey, true)
  captureTarget = null
  if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
    window.removeEventListener('keydown', onBubbleEscapeKey, false)
  }
}
export function useEscape(onClose, active = true, { priority = 0 } = {}) {
  const ref = useRef(onClose)
  ref.current = onClose
  useEffect(() => {
    if (!active) return undefined
    const layer = { ref, priority }
    if (escapeLayers.length === 0) attachEscapeListeners()
    escapeLayers.push(layer)
    return () => {
      const index = escapeLayers.indexOf(layer)
      if (index !== -1) escapeLayers.splice(index, 1)
      if (escapeLayers.length === 0) detachEscapeListeners()
    }
  }, [active, priority])
}
