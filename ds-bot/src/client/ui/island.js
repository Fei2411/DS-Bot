// Canonical top Dynamic Island carrier (`DynamicIsland`, `IslandNotice`, `IslandPod`,
// `IslandPanel`, `IslandPager`).
//
// Every top-of-conversation notification, status pod, approval deck, background-task
// deck, goal bar, pending-learning review, or connection alert mounts inside this single
// morphing glass surface rather than inventing ad-hoc top banners or popups.
import { createElement as h, Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from '../icons.js'
import { SPRING_SHAPE, SPRING_TAP, spring, useMorph } from '../motion.js'
import { ESCAPE_PRIORITY, useEscape } from '../overlay-hooks.js'
import { t } from '../i18n.js'

// Transient horizontal stretch notice inside the main capsule (e.g. "Memory updated").
// Measures its real scrollWidth so the capsule's SPRING_STRETCH runs between true widths.
export function IslandNotice({ shown, icon = null, label, className = '' }) {
  const inner = useRef(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    if (shown) setWidth(inner.current?.scrollWidth ?? 0)
  }, [label, shown])
  return h('span', {
    className: className ? `bt-pill-mem ${className}` : 'bt-pill-mem',
    'aria-hidden': true,
    style: { '--bt-mem-w': `${width}px` },
  },
  h('span', { className: 'bt-pill-mem-in', ref: inner },
    icon ? h('span', { className: 'bt-pill-mem-ico' }, icon) : null,
    label))
}

// One standardized compact row + optional expandable panel inside DynamicIsland.
export function IslandPod({
  dotTone = null,
  icon = null,
  label,
  meta = null,
  count = null,
  faces = null,
  action = null,
  open = false,
  expandable = true,
  onClick = null,
  className = '',
  barClassName = '',
  barAttrs = null,
  panel = null,
}) {
  const interactive = typeof onClick === 'function'
  const barClasses = ['bt-island-pod-bar', barClassName, className].filter(Boolean).join(' ')
  const content = [
    dotTone ? h('span', { key: 'dot', className: 'bt-island-pod-dot', 'data-tone': dotTone, 'aria-hidden': true }) : null,
    icon ? h('span', { key: 'ico', className: 'bt-island-pod-ico', 'aria-hidden': true }, icon) : null,
    h('span', { key: 'lbl', className: 'bt-island-pod-label' }, label),
    meta ? h('span', { key: 'meta', className: 'bt-island-pod-meta' }, meta) : null,
    count !== null && count !== undefined ? h('span', { key: 'cnt', className: 'bt-island-pod-count' }, count) : null,
    faces,
    action,
    expandable && interactive ? h('span', { key: 'chev', className: 'bt-goal-chev', 'aria-hidden': true }, h(ChevronDownIcon)) : null,
  ]
  const bar = interactive
    ? h('button', {
        type: 'button',
        className: barClasses,
        'aria-expanded': expandable ? open : undefined,
        onClick,
        ...barAttrs,
      }, ...content)
    : h('div', { className: barClasses, ...barAttrs }, ...content)
  return h(Fragment, null, bar, open ? panel : null)
}

// Standardized expanded panel body inside DynamicIsland.
export function IslandPanel({ label, className = '', footer = null, children }) {
  return h('div', {
    className: className ? `bt-island-panel ${className}` : 'bt-island-panel',
    role: 'region',
    'aria-label': label,
  },
  h('div', { className: 'bt-island-panel-body' }, children),
  footer ? h('div', { className: 'bt-island-panel-foot' }, footer) : null)
}

// Reusable Left/Right single-card pager for DynamicIsland panels.
export function IslandPager({ count, index, onStep, onSelect = null, label = '', keyboard = true }) {
  const stepRef = useRef(onStep)
  stepRef.current = onStep
  useEffect(() => {
    if (!keyboard || count <= 1 || typeof window === 'undefined') return undefined
    const onKey = (event) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      const target = event.target
      const typing = target && typeof target === 'object' && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable)
      if (typing) return
      if (typeof target?.closest === 'function' && target.closest('[role="dialog"],[role="alertdialog"],[role="slider"],[role="listbox"],[role="menu"]')) return
      if (typeof document !== 'undefined' && typeof document.querySelector === 'function' && document.querySelector('[aria-modal="true"]:not([data-leaving]),[role="alertdialog"]:not([data-leaving])')) return
      event.preventDefault()
      stepRef.current(event.key === 'ArrowLeft' ? -1 : 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [keyboard, count])

  if (count <= 1) return null
  return h('div', { className: 'bt-island-pager', role: 'group', 'aria-label': label || t('Items') },
    h('button', {
      type: 'button', className: 'bt-island-page-btn', 'aria-label': t('Previous'),
      onClick: () => onStep(-1),
    }, h(ChevronLeftIcon)),
    onSelect
      ? h('span', { className: 'bt-island-page-dots', 'aria-hidden': true },
          Array.from({ length: count }, (_, i) => h('button', {
            key: i, type: 'button', tabIndex: -1,
            className: 'bt-island-page-dot', 'data-active': i === index || undefined,
            onClick: () => onSelect(i),
          })))
      : null,
    h('span', { className: 'bt-island-page-num' }, `${index + 1}/${count}`),
    h('button', {
      type: 'button', className: 'bt-island-page-btn', 'aria-label': t('Next'),
      onClick: () => onStep(1),
    }, h(ChevronRightIcon)))
}

function IslandDismiss({ island, close }) {
  const closeRef = useRef(close)
  closeRef.current = close
  useEscape(() => closeRef.current?.(), true, { priority: ESCAPE_PRIORITY.ISLAND })
  useEffect(() => {
    const onDown = (event) => {
      if (!island.current?.contains(event.target)) closeRef.current?.()
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [island])
  return null
}

// The single canonical morphing top surface of DS Bot.
// Accepts the primary `pill` plus an ordered list of active `pods`:
//   { id: string, node: ReactNode, open?: boolean, hoverOnly?: boolean }
export function DynamicIsland({
  pill,
  pods = [],
  compactBadge = null,
  hoverReveal = false,
  expanded = false,
  dismissible = false,
  morphKey = 'closed',
  onClose = null,
  className = '',
  dataAttrs = null,
}) {
  const island = useRef(null)
  const leaveTimer = useRef(null)
  const [hovered, setHovered] = useState(false)
  const visiblePods = pods.filter(entry => entry && entry.node !== null && entry.node !== undefined)
  const hasPods = visiblePods.length > 0
  const anyOpen = expanded || visiblePods.some(entry => entry.open === true)
  const compact = hoverReveal && hasPods && !anyOpen && !hovered
  const resolvedMorphKey = compact ? `compact:${morphKey}` : morphKey
  useMorph(island, resolvedMorphKey, { width: true })

  useEffect(() => () => { if (leaveTimer.current) clearTimeout(leaveTimer.current) }, [])
  useEffect(() => {
    if (!hoverReveal || !hasPods) setHovered(false)
  }, [hoverReveal, hasPods])

  const onEnter = hoverReveal ? () => {
    if (leaveTimer.current) { clearTimeout(leaveTimer.current); leaveTimer.current = null }
    setHovered(true)
  } : undefined
  const onLeave = hoverReveal ? () => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current)
    leaveTimer.current = setTimeout(() => { leaveTimer.current = null; setHovered(false) }, 180)
  } : undefined

  const canDismiss = (anyOpen || dismissible) && typeof onClose === 'function'
  const hasTop = (pill !== null && pill !== undefined) || Boolean(compact && compactBadge)

  return h('div', {
    ref: island,
    className: className ? `bt-island ${className}` : 'bt-island',
    'data-open': anyOpen || undefined,
    'data-compact': compact || undefined,
    'data-no-pill': hasTop ? undefined : '',
    onMouseEnter: onEnter,
    onMouseLeave: onLeave,
    ...dataAttrs,
  },
  canDismiss ? h(IslandDismiss, { island, close: onClose }) : null,
  hasTop ? h('div', { className: 'bt-island-top' }, pill, compact ? compactBadge : null) : null,
  compact || !hasPods
    ? null
    : h('div', { className: 'bt-goal-pod' },
        visiblePods.map((entry, idx) => h(Fragment, { key: entry.id ?? idx },
          idx > 0 ? h('span', { className: 'bt-island-sep', 'aria-hidden': true }) : null,
          entry.node))))
}

export const ISLAND_CSS = `
:where(.bt-island-pod-bar){display:flex;align-items:center;gap:8px;width:100%;min-width:0;min-height:36px;padding:6px 12px 6px 14px;border:0;background:none;color:var(--bt-ink);font:inherit;font-size:13px;line-height:18px;text-align:left;box-sizing:border-box;cursor:pointer;transition:background-color .12s ease}
:where(div.bt-island-pod-bar){cursor:default}
:where(button.bt-island-pod-bar:hover){background:color-mix(in srgb,var(--bt-ink) 5%,transparent)}
:where(button.bt-island-pod-bar:focus-visible){outline:2px solid var(--bt-accent);outline-offset:-2px;border-radius:12px}
:where(.bt-island-pod-dot){flex:none;width:7px;height:7px;border-radius:50%;corner-shape:round;background:var(--bt-accent)}
:where(.bt-island-pod-dot[data-tone=star]){background:var(--bt-star)}
:where(.bt-island-pod-dot[data-tone=warn]){background:var(--bt-warn)}
:where(.bt-island-pod-dot[data-tone=danger]){background:var(--bt-danger)}
:where(.bt-island-pod-dot[data-tone=green]){background:var(--bt-green)}
:where(.bt-island-pod-ico){flex:none;display:inline-flex;width:15px;height:15px;color:var(--bt-ink-2)}
:where(.bt-island-pod-label){flex:1 1 auto;min-width:0;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
:where(.bt-island-pod-meta){flex:none;font-size:12px;line-height:16px;color:var(--bt-ink-3);white-space:nowrap}
:where(.bt-island-pod-count){flex:none;display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:var(--bt-hover);color:var(--bt-ink-2);font-size:11px;line-height:16px;font-weight:600;font-variant-numeric:tabular-nums}
:where(.bt-island-panel){display:flex;flex-direction:column;border-top:.5px solid var(--bt-line);animation:bt-veil-in .22s ease-out backwards}
:where(.bt-island-panel-body){display:flex;flex-direction:column;gap:8px;padding:10px 12px 12px;max-height:min(60vh,520px);overflow:auto}
:where(.bt-island-panel-foot){display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:40px;padding:6px 12px;border-top:.5px solid var(--bt-line);box-sizing:border-box}
:where(.bt-island-pager){display:inline-flex;align-items:center;gap:4px;flex:none}
:where(.bt-island-page-btn){display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:999px;background:none;color:var(--bt-ink-2);cursor:pointer;transition:background-color .12s ease,color .12s ease,${spring(SPRING_TAP, 'scale')}}
:where(.bt-island-page-btn:hover){background:var(--bt-hover);color:var(--bt-ink)}
:where(.bt-island-page-btn:active){scale:.92}
:where(.bt-island-page-btn:focus-visible){outline:2px solid var(--bt-accent);outline-offset:1px}
:where(.bt-island-page-dots){display:inline-flex;align-items:center;gap:4px;padding:0 2px}
:where(.bt-island-page-dot){width:6px;height:6px;padding:0;border:0;border-radius:50%;corner-shape:round;background:var(--bt-line-2);cursor:pointer;transition:background-color .12s ease,${spring(SPRING_SHAPE, 'width')}}
:where(.bt-island-page-dot[data-active]){width:14px;border-radius:999px;background:var(--bt-accent)}
:where(.bt-island-page-num){font-size:11px;line-height:16px;color:var(--bt-ink-3);font-variant-numeric:tabular-nums;padding:0 2px}
:where(.bt-island-conn-btn){flex:none;margin-left:auto}
:where(.bt-island-panel .bt-q){border-radius:12px}
:where(.bt-island-panel .bt-q-head){flex-wrap:wrap}
:where(.bt-island-panel .bt-q-text){flex-basis:140px}
@media (prefers-reduced-motion:reduce){:where(.bt-island-panel){animation:none}:where(.bt-island-page-btn,.bt-island-page-dot){transition:none}}
`
