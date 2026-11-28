// Canonical Slider carrier (`Slider`, `SLIDER_CSS`).
//
// Supports both continuous numeric ranges (Appearance settings: font size, bubble width,
// blur, opacity) and discrete snapped stops (Model thinking level `EffortBar`), sharing
// one tactile track, pointer drag, keyboard navigation, and spring feedback.
import { createElement as h, useEffect, useRef, useState } from 'react'
import { ResetIcon } from '../icons.js'
import { SPRING_SHAPE, SPRING_TAP, spring } from '../motion.js'
import { t } from '../i18n.js'

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function snapContinuous(ratio, min, max, step) {
  const raw = min + ratio * (max - min)
  const snapped = step > 0 ? Math.round((raw - min) / step) * step + min : raw
  const decimals = String(step).includes('.') ? String(step).split('.')[1].length : 0
  return clamp(Number(snapped.toFixed(decimals)), min, max)
}

function useRestingValue(value, onCommit, delay) {
  const [shown, setShown] = useState(value)
  const pending = useRef(undefined)
  const timer = useRef(0)
  const flush = () => {
    clearTimeout(timer.current)
    const next = pending.current
    pending.current = undefined
    if (next !== undefined) next.commit?.(next.value)
  }
  useEffect(() => {
    if (pending.current === undefined) setShown(value)
  }, [value])
  useEffect(() => flush, [])
  const pick = (next, immediate = false) => {
    setShown(next)
    if (!delay || immediate) {
      clearTimeout(timer.current)
      pending.current = undefined
      onCommit?.(next)
      return
    }
    pending.current = { value: next, commit: onCommit }
    clearTimeout(timer.current)
    timer.current = setTimeout(flush, delay)
  }
  return [shown, pick]
}

// Unified continuous or discrete stepped Slider.
export function Slider({
  label,
  value,
  // Continuous mode props
  min = 0,
  max = 100,
  step = 1,
  format = String,
  delay = 0,
  showValue = true,
  // Discrete stepped mode props
  stops = null,
  activeIndex: controlledIndex = null,
  headerLabel = '',
  defaultTag = '',
  valueLabel = '',
  showDots = false,
  onReset = null,
  resetLabel = '',
  resetDisabled = false,
  resetClassName = 'bt-slider-reset',
  // Common props
  disabled = false,
  onChange = null,
  onCommit = null,
  onDragChange = null,
  className = '',
  trackClassName = '',
}) {
  const isStepped = Array.isArray(stops) && stops.length > 0
  const track = useRef(null)
  const drag = useRef(null)
  const [dragRatio, setDragRatio] = useState(null)
  const [shownContinuous, pickContinuous] = useRestingValue(
    isStepped ? 0 : value,
    onCommit,
    delay,
  )

  const count = isStepped ? stops.length : 0
  const safeIndex = isStepped
    ? clamp(
        controlledIndex !== null && controlledIndex !== undefined
          ? controlledIndex
          : Math.max(0, stops.findIndex(stop => (stop.value ?? null) === (value ?? null))),
        0,
        Math.max(0, count - 1),
      )
    : 0
  const activeStop = isStepped ? stops[safeIndex] : null
  const restRatio = isStepped
    ? (count <= 1 ? 1 : safeIndex / (count - 1))
    : (max > min ? clamp((shownContinuous - min) / (max - min), 0, 1) : 0)
  const ratio = dragRatio ?? restRatio

  const ratioAt = (clientX) => {
    const rect = track.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return restRatio
    const inset = isStepped ? 11 : 8
    const span = Math.max(1, rect.width - inset * 2)
    return clamp((clientX - rect.left - inset) / span, 0, 1)
  }

  const updateFromRatio = (r, isDragMove = false) => {
    if (isStepped) {
      const next = stops[Math.round(r * (count - 1))] ?? stops[0]
      if (isDragMove) setDragRatio(r)
      if (next) onChange?.(next.value, next)
      return next?.value
    }
    const next = snapContinuous(r, min, max, step)
    setDragRatio(isDragMove ? r : null)
    onChange?.(next)
    pickContinuous(next, false)
    return next
  }

  const onPointerDown = (event) => {
    if (disabled || event.button !== 0) return
    event.preventDefault()
    event.currentTarget.focus?.({ preventScroll: true })
    try { event.currentTarget.setPointerCapture?.(event.pointerId) } catch {}
    onDragChange?.(true)
    const r = ratioAt(event.clientX)
    const val = updateFromRatio(r, false)
    drag.current = { id: event.pointerId, startX: event.clientX, moved: false, value: val }
  }

  const onPointerMove = (event) => {
    const state = drag.current
    if (!state || state.id !== event.pointerId) return
    if (!state.moved && Math.abs(event.clientX - state.startX) > 2) state.moved = true
    const r = ratioAt(event.clientX)
    state.value = updateFromRatio(r, state.moved)
  }

  const finishDrag = (event) => {
    const state = drag.current
    if (!state || (event && state.id !== event.pointerId)) return
    drag.current = null
    setDragRatio(null)
    onDragChange?.(false)
    if (isStepped) {
      onCommit?.(state.value)
    }
  }

  const onKeyDown = (event) => {
    if (disabled) return
    const keys = ['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp', 'Home', 'End', 'PageUp', 'PageDown']
    if (!keys.includes(event.key)) return
    event.preventDefault()
    event.stopPropagation()
    if (isStepped) {
      const nextIndex = event.key === 'Home' ? 0
        : event.key === 'End' ? count - 1
          : (event.key === 'ArrowLeft' || event.key === 'ArrowDown' || event.key === 'PageDown')
            ? Math.max(0, safeIndex - 1)
            : Math.min(count - 1, safeIndex + 1)
      const next = stops[nextIndex]
      if (next) {
        onChange?.(next.value, next)
        onCommit?.(next.value)
      }
      return
    }
    const bigStep = step * 5
    const delta = event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -step
      : event.key === 'ArrowRight' || event.key === 'ArrowUp' ? step
        : event.key === 'PageDown' ? -bigStep
          : event.key === 'PageUp' ? bigStep : 0
    const next = event.key === 'Home' ? min
      : event.key === 'End' ? max
        : clamp(Number((shownContinuous + delta).toFixed(4)), min, max)
    onChange?.(next)
    pickContinuous(next, false)
  }

  const trackNode = h('div', {
    ref: track,
    className: [isStepped ? 'bt-slider-track bt-effort-track' : 'bt-slider-track bt-slider-track-slim', trackClassName].filter(Boolean).join(' '),
    role: 'slider',
    tabIndex: disabled ? -1 : 0,
    'aria-label': label,
    'aria-disabled': disabled || undefined,
    'aria-valuemin': isStepped ? 0 : min,
    'aria-valuemax': isStepped ? Math.max(0, count - 1) : max,
    'aria-valuenow': isStepped ? safeIndex : shownContinuous,
    'aria-valuetext': isStepped ? (activeStop?.label ?? '') : format(shownContinuous),
    'data-dragging': dragRatio !== null ? '' : undefined,
    style: { '--bt-effort-p': ratio },
    onPointerDown,
    onPointerMove,
    onPointerUp: finishDrag,
    onPointerCancel: finishDrag,
    onLostPointerCapture: finishDrag,
    onKeyDown,
  },
  h('span', { className: isStepped ? 'bt-slider-fill bt-effort-fill' : 'bt-slider-fill bt-slider-fill-slim', 'aria-hidden': true }),
  isStepped && showDots ? stops.map((stop, index) => {
    const dotRatio = count <= 1 ? 1 : index / (count - 1)
    return h('span', {
      key: stop.key ?? stop.value ?? `stop-${index}`,
      className: 'bt-slider-dot bt-effort-dot',
      'data-filled': dotRatio <= ratio + 0.001 || undefined,
      style: { '--bt-dot-p': dotRatio },
      'aria-hidden': true,
    })
  }) : null,
  h('span', { className: isStepped ? 'bt-slider-knob bt-effort-knob' : 'bt-slider-knob bt-slider-knob-slim', 'aria-hidden': true }))

  if (isStepped) {
    return h('div', {
      className: className ? `bt-slider bt-effort-bar ${className}` : 'bt-slider bt-effort-bar',
      role: 'group',
      'aria-label': headerLabel || label,
    },
    headerLabel ? h('div', { className: 'bt-effort-head' },
      h('span', { className: 'bt-effort-label' }, headerLabel),
      h('span', { className: 'bt-effort-meta' },
        defaultTag ? h('span', { className: 'bt-effort-tag' }, defaultTag) : null,
        h('span', { className: 'bt-effort-val' }, valueLabel || activeStop?.label || ''),
        onReset ? h('button', {
          type: 'button',
          className: resetClassName,
          'aria-label': resetLabel || t('Default'),
          disabled: disabled || resetDisabled,
          onClick: onReset,
        }, h(ResetIcon)) : null)) : null,
    trackNode)
  }

  return h('div', {
    className: className ? `bt-range bt-slider-row ${className}` : 'bt-range bt-slider-row',
    style: { '--bt-fill': `${ratio * 100}%` },
  },
  trackNode,
  showValue ? h('output', null, format(shownContinuous)) : null)
}

export const SLIDER_CSS = `
:where(.bt-slider-row){display:flex;align-items:center;gap:10px;width:216px;max-width:100%}
:where(.bt-slider-track-slim){flex:1;min-width:0;position:relative;height:28px;border-radius:999px;cursor:pointer;user-select:none;touch-action:none}
:where(.bt-slider-track-slim)::before{content:"";position:absolute;left:0;right:0;top:50%;height:4px;transform:translateY(-50%);border-radius:999px;background:var(--bt-active)}
:where(.bt-slider-track-slim:focus-visible){outline:2px solid var(--bt-accent);outline-offset:2px}
:where(.bt-slider-track-slim[aria-disabled=true]){opacity:.45;cursor:default}
:where(.bt-slider-fill-slim){position:absolute;left:0;top:50%;height:4px;transform:translateY(-50%);width:calc(8px + (100% - 16px) * var(--bt-effort-p,0));border-radius:999px;background:var(--bt-accent);pointer-events:none;transition:${spring(SPRING_SHAPE, 'width')}}
:where(.bt-slider-knob-slim){position:absolute;top:50%;left:calc(8px + (100% - 16px) * var(--bt-effort-p,0));width:16px;height:16px;transform:translate(-50%,-50%);border-radius:50%;corner-shape:round;background:var(--bt-knob);box-shadow:0 1px 4px rgba(0,0,0,.24),0 0 0 .5px var(--bt-line-2);pointer-events:none;transition:${spring(SPRING_SHAPE, 'left')},${spring(SPRING_TAP, 'scale')}}
:where(.bt-slider-track-slim[data-dragging] .bt-slider-fill-slim,.bt-slider-track-slim[data-dragging] .bt-slider-knob-slim){transition:none}
:where(.bt-slider-track-slim:hover .bt-slider-knob-slim,.bt-slider-track-slim[data-dragging] .bt-slider-knob-slim){scale:1.12}
@media (prefers-reduced-motion:reduce){:where(.bt-slider-fill-slim,.bt-slider-knob-slim){transition:none}}
`
