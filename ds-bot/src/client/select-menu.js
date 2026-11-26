import { createElement as h, Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckIcon, ChevronDownIcon } from './icons.js'
import { useLinger, useViewport, viewBottom } from './motion.js'
import { registerPopupOwner } from './popup-ownership.js'
import { ESCAPE_PRIORITY, useEscape } from './overlay-hooks.js'

const MENU_EXIT_MS = 120
const TYPEAHEAD_RESET_MS = 500
const VIEW_MARGIN = 8
const POPUP_GAP = 4

const isGroup = entry => entry !== null && typeof entry === 'object' && Array.isArray(entry.options)

export function flattenOptions(options) {
  const flat = []
  for (const entry of options ?? []) {
    if (isGroup(entry)) {
      for (const option of entry.options) flat.push(option)
    } else if (entry !== null && entry !== undefined) {
      flat.push(entry)
    }
  }
  return flat
}

// Places the listbox beneath or above its trigger within the visible viewport,
// clamping horizontally and capping height so long lists scroll inside the menu.
export function measureSelectPlace(trigger, { variant = 'default', minMenuWidth, menuWidth, menuHeight } = {}) {
  if (!trigger || typeof trigger.getBoundingClientRect !== 'function' || typeof window === 'undefined') {
    return { left: VIEW_MARGIN, top: VIEW_MARGIN }
  }
  const rect = trigger.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = viewBottom()
  const compact = variant === 'compact'
  const baseMin = minMenuWidth ?? (compact ? 112 : 180)
  const maxAllowedW = Math.max(80, vw - VIEW_MARGIN * 2)
  const minWidth = Math.min(Math.max(baseMin, Math.ceil(rect.width)), maxAllowedW)
  const maxWidth = Math.min(compact ? 220 : 360, maxAllowedW)
  const effectiveW = menuWidth ? Math.min(Math.max(minWidth, Math.ceil(menuWidth)), maxWidth) : minWidth
  let rawLeft
  let originX
  if (compact) {
    rawLeft = rect.left + (rect.width - effectiveW) / 2
    originX = 'center'
  } else if (rect.left + rect.width / 2 > vw / 2) {
    rawLeft = rect.right - effectiveW
    originX = 'right'
  } else {
    rawLeft = rect.left
    originX = 'left'
  }
  const left = Math.round(Math.max(VIEW_MARGIN, Math.min(rawLeft, vw - effectiveW - VIEW_MARGIN)))
  const below = Math.max(0, vh - rect.bottom - POPUP_GAP - VIEW_MARGIN)
  const above = Math.max(0, rect.top - POPUP_GAP - VIEW_MARGIN)
  const cap = Math.min(320, Math.floor(vh * 0.5))
  const needed = menuHeight ? Math.min(menuHeight, cap) : 220
  if (below >= needed || below >= above) {
    const maxHeight = Math.max(48, Math.min(cap, Math.floor(below)))
    return {
      left,
      top: Math.round(rect.bottom + POPUP_GAP),
      minWidth,
      maxWidth,
      maxHeight,
      '--bt-origin': `top ${originX}`,
    }
  }
  const maxHeight = Math.max(48, Math.min(cap, Math.floor(above)))
  return {
    left,
    bottom: Math.round(window.innerHeight - rect.top + POPUP_GAP),
    minWidth,
    maxWidth,
    maxHeight,
    '--bt-origin': `bottom ${originX}`,
  }
}

function samePlace(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  return a.left === b.left && a.top === b.top && a.bottom === b.bottom
    && a.minWidth === b.minWidth && a.maxWidth === b.maxWidth && a.maxHeight === b.maxHeight
    && a['--bt-origin'] === b['--bt-origin']
}

function paddingOf(box) {
  if (typeof getComputedStyle !== 'function') return { top: 0, bottom: 0 }
  const style = getComputedStyle(box)
  const top = Number.parseFloat(style.paddingTop)
  const bottom = Number.parseFloat(style.paddingBottom)
  return { top: Number.isFinite(top) ? top : 0, bottom: Number.isFinite(bottom) ? bottom : 0 }
}

// Reads an option's unscaled vertical geometry relative to `box`'s content top.
// Prefers transform-invariant offsetTop/offsetHeight so CSS scale() entrance
// animations (bt-pop-drop) never skew row measurements; falls back to
// getBoundingClientRect() only for synthetic DOM mocks without offset metrics.
function optionBoxMetrics(box, option) {
  if (typeof option?.offsetHeight === 'number' && option.offsetHeight > 0 && typeof option.offsetTop === 'number') {
    if (!option.offsetParent || option.offsetParent === box) {
      return { top: option.offsetTop, height: option.offsetHeight }
    }
    if (option.offsetParent === box?.offsetParent && typeof box?.offsetTop === 'number') {
      return { top: option.offsetTop - box.offsetTop, height: option.offsetHeight }
    }
  }
  const boxRect = box?.getBoundingClientRect?.()
  const itemRect = option?.getBoundingClientRect?.()
  if (!boxRect || !itemRect || itemRect.height <= 0) return null
  return { top: itemRect.top - boxRect.top + (box.scrollTop ?? 0), height: itemRect.height }
}

// Snaps a scrollable flat listbox's maxHeight down to a whole number of rows so
// neither the top nor the bottom row is half-clipped at the scroll bounds.
export function snapListMaxHeight(box, rawMaxHeight, scrollerArg = null) {
  const scroller = scrollerArg ?? box?.querySelector?.('.bt-sel-list') ?? box
  if (!box || !scroller || !Number.isFinite(rawMaxHeight)) return rawMaxHeight
  if (scroller.clientHeight <= 0 || scroller.scrollHeight <= scroller.clientHeight) return rawMaxHeight
  if (scroller.querySelector?.('.bt-sel-group')) return rawMaxHeight
  const options = Array.from(scroller.querySelectorAll?.('button[role="option"]') ?? [])
  if (options.length < 2) return rawMaxHeight
  let rowH
  let stride
  if (typeof options[0].offsetHeight === 'number' && options[0].offsetHeight > 0
    && typeof options[0].offsetTop === 'number' && typeof options[1].offsetTop === 'number'
    && options[0].offsetParent === options[1].offsetParent) {
    rowH = Math.round(options[0].offsetHeight)
    stride = Math.round(options[1].offsetTop - options[0].offsetTop)
  } else {
    const r0 = options[0].getBoundingClientRect?.()
    const r1 = options[1].getBoundingClientRect?.()
    if (!r0 || !r1 || r0.height <= 0) return rawMaxHeight
    rowH = Math.round(r0.height)
    stride = Math.round(r1.top - r0.top)
  }
  if (stride < rowH) return rawMaxHeight
  const gap = stride - rowH
  let frameY
  if (scroller !== box) {
    if ((box.offsetHeight ?? 0) <= 0) return rawMaxHeight
    frameY = Math.max(0, box.offsetHeight - scroller.clientHeight)
  } else {
    const { top: padTop, bottom: padBottom } = paddingOf(box)
    const borderY = Math.max(0, (box.offsetHeight ?? 0) - (box.clientHeight ?? 0))
    frameY = borderY + padTop + padBottom
  }
  const avail = rawMaxHeight - frameY
  const count = Math.floor((avail + gap) / stride)
  if (count < 1 || count >= options.length) return rawMaxHeight
  return Math.round(frameY + count * rowH + (count - 1) * gap)
}

// Scrolls an option into view inside `box` without scrolling any ancestor container,
// snapping scrollTop to a whole-option top boundary so the first visible row is never half-clipped.
function revealInBox(box, item, center = false) {
  if (!box || !item || box.scrollHeight <= box.clientHeight) return
  const itemMetrics = optionBoxMetrics(box, item)
  if (!itemMetrics) return
  const { top: padTop, bottom: padBottom } = paddingOf(box)
  const maxScroll = Math.max(0, box.scrollHeight - box.clientHeight)
  const { top, height: itemHeight } = itemMetrics
  const bottom = top + itemHeight
  let desired
  if (center) {
    desired = Math.max(0, Math.min(maxScroll, top - Math.floor((box.clientHeight - itemHeight) / 2)))
  } else if (top < box.scrollTop + padTop) {
    desired = Math.max(0, top - padTop)
  } else if (bottom > box.scrollTop + box.clientHeight - padBottom) {
    desired = Math.min(maxScroll, bottom - box.clientHeight + padBottom)
  } else {
    return
  }
  const options = Array.from(box.querySelectorAll?.('button[role="option"]') ?? [])
  const candidates = []
  for (const option of options) {
    const metrics = optionBoxMetrics(box, option)
    if (!metrics) continue
    const snap = Math.max(0, Math.min(maxScroll, Math.round(metrics.top - padTop)))
    if (snap <= top - padTop + 1 && bottom <= snap + box.clientHeight - padBottom + 1) candidates.push(snap)
  }
  if (candidates.length > 0) {
    let best = candidates[0]
    let bestDist = Math.abs(best - desired)
    for (let i = 1; i < candidates.length; i += 1) {
      const dist = Math.abs(candidates[i] - desired)
      if (dist < bestDist) { best = candidates[i]; bestDist = dist }
    }
    box.scrollTop = best
    return
  }
  box.scrollTop = Math.round(desired)
}

export function SelectMenu({
  value,
  onChange,
  options = [],
  placeholder = '',
  disabled = false,
  variant = 'default',
  className = '',
  menuClassName = '',
  id,
  title,
  minMenuWidth,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledby,
  'data-tour': dataTour,
}) {
  const listboxId = useId()
  const button = useRef(null)
  const menu = useRef(null)
  const list = useRef(null)
  const openIntent = useRef(null)
  const typeahead = useRef({ query: '', at: 0 })
  const [place, setPlace] = useState(null)
  const [shownPlace, leaving] = useLinger(place, MENU_EXIT_MS)
  const isOpen = place !== null
  const tick = useViewport(isOpen)
  const [resizeTick, setResizeTick] = useState(0)

  const flat = useMemo(() => flattenOptions(options), [options])
  const selected = flat.find(option => Object.is(option.value, value))
  const isDisabled = disabled || flat.length === 0
  const isPlaceholder = selected === undefined && placeholder !== ''
  const displayLabel = selected ? selected.label : (placeholder || (value !== undefined && value !== null ? String(value) : ''))

  useLayoutEffect(() => registerPopupOwner(button, menu), [])

  const close = () => {
    openIntent.current = null
    setPlace(null)
  }

  const open = (intent = 'pointer') => {
    if (isDisabled) return
    openIntent.current = intent
    setPlace(measureSelectPlace(button.current, { variant, minMenuWidth }))
  }

  useEffect(() => {
    if (isDisabled && isOpen) close()
  }, [isDisabled, isOpen])

  useEscape(() => {
    close()
    button.current?.focus?.({ preventScroll: true })
  }, isOpen, { priority: ESCAPE_PRIORITY.SELECT_MENU })

  useEffect(() => {
    if (!isOpen || typeof window === 'undefined') return undefined
    const onResize = () => setResizeTick(count => count + 1)
    const onDown = (event) => {
      if (menu.current?.contains(event.target) || button.current?.contains(event.target)) return
      const wrappingLabel = event.target?.closest?.('label')
      if (wrappingLabel && button.current && wrappingLabel.contains(button.current)) return
      close()
    }
    const onScroll = (event) => {
      if (!menu.current?.contains(event.target)) close()
    }
    const onKey = (event) => {
      if (event.key === 'Tab') {
        button.current?.focus?.({ preventScroll: true })
        close()
        return
      }
      const box = menu.current
      if (!box) return
      const scroller = list.current ?? box
      const items = Array.from(box.querySelectorAll?.('button[role="option"]:not(:disabled)') ?? [])
      if (items.length === 0) return
      const active = typeof document === 'undefined' ? null : document.activeElement
      if (active && active !== box && active !== button.current && !box.contains(active)) return
      const current = items.indexOf(active)
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault()
        event.stopPropagation()
        let next
        if (event.key === 'Home') next = 0
        else if (event.key === 'End') next = items.length - 1
        else if (current === -1) {
          const pickedIdx = items.findIndex(node => node.getAttribute('aria-selected') === 'true')
          if (event.key === 'ArrowDown') next = pickedIdx >= 0 ? (pickedIdx + 1) % items.length : 0
          else next = pickedIdx >= 0 ? (pickedIdx - 1 + items.length) % items.length : items.length - 1
        } else {
          next = event.key === 'ArrowDown'
            ? (current + 1) % items.length
            : (current - 1 + items.length) % items.length
        }
        revealInBox(scroller, items[next])
        items[next]?.focus?.({ preventScroll: true })
        return
      }
      if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1 && event.key.trim() !== '') {
        const now = Date.now()
        const state = typeahead.current
        const nextQuery = now - state.at > TYPEAHEAD_RESET_MS ? event.key.toLowerCase() : state.query + event.key.toLowerCase()
        typeahead.current = { query: nextQuery, at: now }
        const start = current >= 0 ? (current + 1) % items.length : 0
        const ordered = [...items.slice(start), ...items.slice(0, start)]
        const match = ordered.find(node => (node.textContent ?? '').trim().toLowerCase().startsWith(nextQuery))
        if (match) {
          event.preventDefault()
          event.stopPropagation()
          revealInBox(scroller, match)
          match.focus?.({ preventScroll: true })
        }
      }
    }
    window.addEventListener('resize', onResize)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [isOpen])

  // Refines horizontal clamping, flip & whole-row height snap after the portal mounts,
  // then scrolls the active item cleanly into view on initial open.
  useLayoutEffect(() => {
    if (!isOpen) return
    const box = menu.current
    const scroller = list.current ?? box
    let refined = false
    if (button.current) {
      const frameY = box && scroller && scroller !== box ? Math.max(0, (box.offsetHeight ?? 0) - (scroller.clientHeight ?? 0)) : 0
      const contentHeight = scroller ? scroller.scrollHeight + frameY : box?.scrollHeight
      const measured = measureSelectPlace(button.current, {
        variant,
        minMenuWidth,
        menuWidth: box?.offsetWidth,
        menuHeight: contentHeight,
      })
      const snappedMaxHeight = box && measured.maxHeight !== undefined ? snapListMaxHeight(box, measured.maxHeight, scroller) : measured.maxHeight
      const next = snappedMaxHeight === measured.maxHeight ? measured : { ...measured, maxHeight: snappedMaxHeight }
      if (!samePlace(place, next)) {
        refined = true
        setPlace(next)
      }
    }
    if (refined) return
    const intent = openIntent.current
    if (intent === null || !box) return
    openIntent.current = null
    const items = Array.from(box.querySelectorAll?.('button[role="option"]:not(:disabled)') ?? [])
    const activeItem = items.find(node => node.getAttribute('aria-selected') === 'true')
    const scrollTarget = activeItem ?? box.querySelector?.('button[role="option"][aria-selected="true"]')
    if (scrollTarget && scroller) revealInBox(scroller, scrollTarget, true)
    if (intent === 'pointer') {
      box.focus?.({ preventScroll: true })
    } else if (items.length > 0) {
      const focusTarget = activeItem ?? (intent === 'last' ? items[items.length - 1] : items[0])
      if (focusTarget) {
        if (scroller) revealInBox(scroller, focusTarget, true)
        focusTarget.focus?.({ preventScroll: true })
      }
    }
  }, [isOpen, place, tick, resizeTick, variant, minMenuWidth, flat.length])

  const choose = (option) => {
    if (option.disabled) return
    close()
    button.current?.focus?.({ preventScroll: true })
    if (!Object.is(option.value, value)) onChange?.(option.value)
  }

  const renderOption = (option, key) => {
    const isSelected = Object.is(option.value, value)
    return h('button', {
      key,
      type: 'button',
      role: 'option',
      className: 'bt-sel-opt',
      'aria-selected': isSelected,
      disabled: option.disabled === true,
      title: option.title,
      onClick: () => choose(option),
      onKeyDown: (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.stopPropagation()
        }
      },
    },
    h('span', { className: 'bt-menu-label' }, option.label),
    h('span', { className: 'bt-sel-tick', 'aria-hidden': true }, isSelected ? h(CheckIcon) : null))
  }

  const menuContent = (options ?? []).map((entry, index) => {
    if (isGroup(entry)) {
      return h('div', { key: `g:${entry.group}:${index}`, role: 'group', 'aria-label': entry.group, className: 'bt-sel-group-box' },
        h('div', { className: 'bt-sel-group', 'aria-hidden': true }, entry.group),
        entry.options.map((option, optIndex) => renderOption(option, `${String(option.value)}:${optIndex}`)))
    }
    return renderOption(entry, `${String(entry.value)}:${index}`)
  })

  const triggerClass = className ? `bt-sel ${className}` : 'bt-sel'
  const popupClass = `bt-menu bt-sel-menu${shownPlace?.bottom !== undefined ? ' bt-menu-up' : ''}${menuClassName ? ` ${menuClassName}` : ''}`
  const portalTarget = typeof document === 'undefined' ? null : document.body

  return h(Fragment, null,
    h('button', {
      ref: button,
      id,
      type: 'button',
      className: triggerClass,
      'data-variant': variant === 'compact' ? 'compact' : undefined,
      'data-placeholder': isPlaceholder ? '' : undefined,
      'data-value': value === undefined || value === null ? '' : String(value),
      'data-tour': dataTour,
      'aria-haspopup': 'listbox',
      'aria-expanded': isOpen,
      'aria-controls': isOpen ? listboxId : undefined,
      'aria-label': ariaLabel,
      'aria-labelledby': ariaLabelledby,
      title: title ?? (typeof displayLabel === 'string' && displayLabel !== '' ? displayLabel : undefined),
      disabled: isDisabled,
      onClick: (event) => {
        if (isOpen) { close(); return }
        open(event?.detail === 0 ? 'first' : 'pointer')
      },
      onKeyDown: (event) => {
        if (isOpen) return
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          event.stopPropagation()
          open('first')
        } else if (event.key === 'ArrowUp') {
          event.preventDefault()
          event.stopPropagation()
          open('last')
        }
      },
    },
    h('span', { className: 'bt-sel-label' }, displayLabel),
    h('span', { className: 'bt-sel-caret', 'aria-hidden': true }, h(ChevronDownIcon))),
    shownPlace && portalTarget ? createPortal(h('div', {
      ref: menu,
      id: listboxId,
      role: 'listbox',
      tabIndex: -1,
      className: popupClass,
      'aria-label': ariaLabel,
      'aria-labelledby': ariaLabelledby,
      'data-compact': variant === 'compact' ? '' : undefined,
      'data-leaving': leaving ? '' : undefined,
      style: shownPlace,
    }, h('div', { ref: list, className: 'bt-sel-list', role: 'none' }, menuContent)), portalTarget) : null)
}
