import { useEffect, useRef } from 'react'

// -------------------------------------------------------------------------
// Overlays: new chat, bot exchange, details drawer, context menu

// Escape closes only the newest open layer at the highest priority, so a dialog,
// menu, or inline editor over the details pane does not take the pane down with it.
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
const onEscapeKey = (event) => {
  if (event.defaultPrevented || event.key !== 'Escape' || event.isComposing || event.keyCode === 229) return
  topEscapeLayer()?.ref.current()
}
export function useEscape(onClose, active = true, { priority = 0 } = {}) {
  const ref = useRef(onClose)
  ref.current = onClose
  useEffect(() => {
    if (!active) return undefined
    const layer = { ref, priority }
    if (escapeLayers.length === 0) window.addEventListener('keydown', onEscapeKey)
    escapeLayers.push(layer)
    return () => {
      const index = escapeLayers.indexOf(layer)
      if (index !== -1) escapeLayers.splice(index, 1)
      if (escapeLayers.length === 0) window.removeEventListener('keydown', onEscapeKey)
    }
  }, [active, priority])
}
