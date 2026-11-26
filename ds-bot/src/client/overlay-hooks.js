import { useEffect, useLayoutEffect, useRef } from 'react'
import { ownedPopups } from './popup-ownership.js'

const useSafeLayoutEffect = (typeof window !== 'undefined' && typeof document !== 'undefined' && typeof useLayoutEffect === 'function')
  ? useLayoutEffect
  : useEffect

// Ref-counted inert locks shared across SettingsTour and foreground modals
// (ShortcutsDialog, PresetConfigModal, etc.) so overlapping mount/unmount and
// MutationObserver timing never clobbers another modal's background isolation.
const inertLocks = new WeakMap()

export function acquireInert(element) {
  if (!element || typeof element !== 'object') return
  const existing = inertLocks.get(element)
  if (existing) {
    existing.count += 1
    element.inert = true
    return
  }
  inertLocks.set(element, { count: 1, initial: Boolean(element.inert) })
  element.inert = true
}

export function releaseInert(element) {
  if (!element || typeof element !== 'object') return
  const existing = inertLocks.get(element)
  if (!existing) return
  existing.count -= 1
  if (existing.count <= 0) {
    inertLocks.delete(element)
    element.inert = existing.initial
  }
}

const FOCUSABLE_SELECTOR = 'button,input,select,textarea,a[href],[tabindex],[contenteditable],summary,audio[controls],video[controls]'

function isElementFocusable(element, doc, requireRects) {
  if (!element || typeof element.focus !== 'function') return false
  if (element.tabIndex < 0) return false
  if (typeof element.matches === 'function' && element.matches(':disabled')) return false
  if (element.disabled === true || element.hidden === true) return false
  if (typeof element.closest === 'function' && (element.closest('[inert]') || element.closest('[hidden]'))) return false
  const style = doc?.defaultView?.getComputedStyle?.(element)
  if (style && (style.display === 'none' || style.visibility === 'hidden')) return false
  if (requireRects && typeof element.getClientRects === 'function' && element.getClientRects().length === 0) return false
  return true
}

export function collectFocusableControls(roots, doc) {
  const seen = new Set()
  const controls = []
  for (const root of roots) {
    if (!root || typeof root.querySelectorAll !== 'function') continue
    const requireRects = typeof root.getClientRects === 'function' && root.getClientRects().length > 0
    const candidates = [root, ...root.querySelectorAll(FOCUSABLE_SELECTOR)]
    for (const element of candidates) {
      if (seen.has(element)) continue
      if (!isElementFocusable(element, doc, requireRects)) continue
      seen.add(element)
      controls.push(element)
    }
  }
  return controls
}

function activeModalsIn(doc) {
  if (!doc || typeof doc.querySelectorAll !== 'function') return []
  return [...doc.querySelectorAll('[aria-modal="true"], [role="alertdialog"]')]
    .filter(modal => !(typeof modal.closest === 'function' && modal.closest('[data-leaving]')))
}

function hasHigherModalThan(container, doc) {
  const modals = activeModalsIn(doc)
  if (modals.length === 0) return false
  let selfIdx = -1
  for (let i = 0; i < modals.length; i += 1) {
    const modal = modals[i]
    if (modal === container || (typeof container.contains === 'function' && container.contains(modal))) {
      selfIdx = i
    }
  }
  if (selfIdx < 0) return modals.length > 0
  for (let i = selfIdx + 1; i < modals.length; i += 1) {
    const modal = modals[i]
    if (modal === container || (typeof container.contains === 'function' && container.contains(modal))) continue
    return true
  }
  return false
}

// Traps Tab / Shift+Tab and isolates background siblings with ref-counted `inert`
// while a foreground modal (such as ShortcutsDialog or PresetConfigModal) is open.
export function useModalFocusTrap(containerRef, active = true, { initialFocusRef } = {}) {
  useSafeLayoutEffect(() => {
    if (!active) return undefined
    const container = containerRef?.current ?? null
    const doc = container?.ownerDocument ?? (typeof document === 'undefined' ? null : document)
    if (!doc) return undefined

    const returnFocus = doc.activeElement
    const restorePreviousFocus = () => {
      const activeEl = doc.activeElement
      const insideClosing = Boolean(container && typeof container.contains === 'function' && container.contains(activeEl))
      const shouldRestore = !activeEl || activeEl === doc.body || activeEl === doc.documentElement || insideClosing
      if (!shouldRestore || !returnFocus || returnFocus.isConnected === false || typeof returnFocus.focus !== 'function') return
      if (returnFocus.closest?.('[inert]')) return
      const remainingModals = activeModalsIn(doc).filter(m => m !== container && !(container && typeof container.contains === 'function' && container.contains(m)))
      if (remainingModals.length === 0 || remainingModals.some(m => typeof m.contains === 'function' && m.contains(returnFocus))) {
        returnFocus.focus({ preventScroll: true })
      }
    }

    if (!container || !doc.body || typeof doc.addEventListener !== 'function') {
      initialFocusRef?.current?.focus?.({ preventScroll: true })
      return restorePreviousFocus
    }

    const held = new Set()
    let allowedRoots = [container]
    let disposed = false

    const releaseAll = () => {
      for (const el of held) releaseInert(el)
      held.clear()
    }

    const isolateBody = (roots) => {
      const nextHeld = new Set()
      const walk = (element) => {
        if (!element || roots.includes(element)) return
        if (roots.some(root => typeof element.contains === 'function' && element.contains(root))) {
          for (const child of element.children ?? []) walk(child)
        } else {
          nextHeld.add(element)
        }
      }
      walk(doc.body)
      for (const el of nextHeld) {
        if (!held.has(el)) {
          acquireInert(el)
          held.add(el)
        }
      }
      for (const el of held) {
        if (!nextHeld.has(el)) {
          releaseInert(el)
          held.delete(el)
        }
      }
    }

    const focusInside = () => {
      const preferred = initialFocusRef?.current
      if (preferred && container.contains(preferred) && !preferred.closest?.('[inert]')) {
        preferred.focus?.({ preventScroll: true })
        return
      }
      const controls = collectFocusableControls(allowedRoots, doc)
      ;(controls[0] ?? container).focus?.({ preventScroll: true })
    }

    const isAllowed = (element) => Boolean(element) && allowedRoots.some(root => root.contains(element))

    const sync = () => {
      if (disposed) return
      if (hasHigherModalThan(container, doc)) {
        releaseAll()
        allowedRoots = [container]
        return
      }
      allowedRoots = [container, ...ownedPopups([container])]
      isolateBody(allowedRoots)
      if (!isAllowed(doc.activeElement)) focusInside()
    }

    const onFocusIn = () => {
      queueMicrotask(() => { if (!disposed) sync() })
    }

    const onKeyDown = (event) => {
      if (event.key !== 'Tab') return
      if (hasHigherModalThan(container, doc)) return
      sync()
      const controls = collectFocusableControls(allowedRoots, doc)
      event.preventDefault()
      event.stopPropagation()
      if (controls.length === 0) {
        container.focus?.({ preventScroll: true })
        return
      }
      const current = controls.indexOf(doc.activeElement)
      const nextIndex = current < 0
        ? (event.shiftKey ? controls.length - 1 : 0)
        : (current + (event.shiftKey ? -1 : 1) + controls.length) % controls.length
      controls[nextIndex]?.focus?.({ preventScroll: true })
    }

    sync()
    let observer = null
    if (typeof MutationObserver === 'function') {
      observer = new MutationObserver(sync)
      observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-leaving', 'aria-modal', 'role'] })
    }
    doc.addEventListener('focusin', onFocusIn, true)
    doc.addEventListener('keydown', onKeyDown, true)

    return () => {
      disposed = true
      observer?.disconnect()
      doc.removeEventListener('focusin', onFocusIn, true)
      doc.removeEventListener('keydown', onKeyDown, true)
      releaseAll()
      restorePreviousFocus()
    }
  }, [active, containerRef, initialFocusRef])
}

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
    if (dialog && typeof dialog.contains === 'function' && dialog.contains(modal)) continue
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
