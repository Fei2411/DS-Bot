// Canonical anchored popover / menu carrier (`PopoverMenu`, `useAnchoredMenu`,
// `useInlineMenu`, `Collapse`).
//
// Consolidates viewport-aware anchor placement, portal rendering, spring exit linger,
// Escape priority, outside-click dismissal, and keyboard menu stepping into one module.
import { createElement as h, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { SPRING_SHAPE, stepMenuFocus, useLinger, useViewport, viewBottom } from '../motion.js'
import { ESCAPE_PRIORITY, useEscape } from '../overlay-hooks.js'
import { registerPopupOwner } from '../popup-ownership.js'

export const MENU_EXIT_MS = 120

// A menu that opens under its trigger, or above when the window has no room below.
// A click outside, Escape, or a scroll outside it closes it.
export function useAnchoredMenu(minWidth = 240, align = 'right') {
  const [anchor, setAnchor] = useState(null)
  const [place, setPlace] = useState(null)
  const [shownPlace, leaving] = useLinger(place, MENU_EXIT_MS)
  const button = useRef(null)
  const menu = useRef(null)
  useLayoutEffect(() => registerPopupOwner(button, menu), [button, menu])
  const tick = useViewport(anchor !== null || Boolean(shownPlace))
  const close = () => { setAnchor(null); setPlace(null) }
  useEffect(() => {
    if (place === null) return undefined
    const onDown = (event) => {
      if (menu.current?.contains(event.target) || button.current?.contains(event.target)) return
      close()
    }
    const onKey = (event) => {
      stepMenuFocus(menu.current, event, button.current)
    }
    const onScroll = (event) => { if (!menu.current?.contains(event.target)) close() }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [place])
  useEscape(() => { close(); button.current?.focus() }, place !== null, { priority: ESCAPE_PRIORITY.MENU })
  const open = () => setAnchor({})
  useLayoutEffect(() => {
    if (anchor === null || !button.current) return
    const rect = button.current.getBoundingClientRect()
    const width = Math.min(Math.max(minWidth, rect.width), window.innerWidth - 16)
    const rawLeft = align === 'left' ? rect.left : rect.right - width
    const left = Math.max(8, Math.min(rawLeft, window.innerWidth - width - 8))
    const below = viewBottom() - rect.bottom
    const originX = align === 'left' ? 'left' : 'right'
    setPlace(below >= 260 || below >= rect.top
      ? { left, width, top: rect.bottom + 4, maxHeight: below - 16, '--bt-origin': `top ${originX}` }
      : { left, width, bottom: viewBottom() - rect.top + 4, maxHeight: rect.top - 16, '--bt-origin': `bottom ${originX}` })
  }, [anchor, tick, minWidth, align])
  return { isOpen: place !== null, shownPlace, leaving, button, menu, open, close }
}

// The same menu opened in the flow under its trigger, so what follows it moves with it.
export function useInlineMenu() {
  const [isOpen, setOpen] = useState(false)
  const root = useRef(null)
  const button = useRef(null)
  const menu = useRef(null)
  const close = () => setOpen(false)
  useEffect(() => {
    if (!isOpen) return undefined
    const onDown = (event) => { if (!root.current?.contains(event.target)) close() }
    const onKey = (event) => {
      stepMenuFocus(menu.current, event, button.current)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [isOpen])
  useEscape(() => { close(); button.current?.focus() }, isOpen, { priority: ESCAPE_PRIORITY.MENU })
  return { isOpen, root, button, menu, open: () => setOpen(true), close }
}

// Content that grows from nothing and shrinks back to nothing in the flow on SPRING_SHAPE.
export function Collapse({ open, children }) {
  const [shown] = useLinger(open, SPRING_SHAPE.duration)
  const [expanded, setExpanded] = useState(open)
  const box = useRef(null)
  const last = useRef(children)
  if (open) last.current = children
  useLayoutEffect(() => {
    if (open) void box.current?.offsetHeight
    setExpanded(open)
  }, [open])
  if (!shown) return null
  return h('div', { ref: box, className: 'bt-collapse', 'data-open': expanded || undefined },
    h('div', { className: 'bt-collapse-in' }, open ? children : last.current))
}

// Declarative portal popover menu backed by `useAnchoredMenu`.
export function PopoverMenu({
  menuRef,
  place,
  leaving = false,
  label,
  role = 'menu',
  className = '',
  style = null,
  children,
}) {
  if (!place || typeof document === 'undefined') return null
  const up = place.bottom !== undefined
  const classes = ['bt-menu', up ? 'bt-menu-up' : '', className].filter(Boolean).join(' ')
  return createPortal(h('div', {
    ref: menuRef,
    className: classes,
    role,
    'aria-label': label,
    'data-leaving': leaving ? '' : undefined,
    style: style ? { ...place, ...style } : place,
  }, children), document.body)
}
