import { createElement as h, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { effectsTier, reducedEffects, reducedMotion } from './effects.js'

export { effectsTier, reducedEffects, reducedMotion }

// Touch devices never hover: controls revealed on hover need a tap path instead.
export const noHover = () => window.matchMedia?.('(hover: none)').matches === true

// The bottom edge of what the user can see: window.innerHeight, or the visible
// region the visual viewport reports while the on-screen keyboard is open —
// innerHeight does not shrink for it.
export const viewBottom = () => (window.visualViewport ? window.visualViewport.height + window.visualViewport.offsetTop : window.innerHeight)

// Re-renders whenever the visual viewport moves or resizes (keyboard opens, the
// URL bar collapses), so anchored layers can re-read their anchor's rect.
// `enabled` false listens to nothing, for a layer that is not open.
export function useViewport(enabled = true) {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const viewport = window.visualViewport
    if (!enabled || !viewport) return undefined
    const bump = () => setTick(value => value + 1)
    viewport.addEventListener('resize', bump)
    viewport.addEventListener('scroll', bump)
    return () => { viewport.removeEventListener('resize', bump); viewport.removeEventListener('scroll', bump) }
  }, [enabled])
  return tick
}

// A damped spring (mass 1) sampled into a CSS linear() easing, for WAAPI glides
// and CSS transitions alike.
export function springEasing(stiffness, damping) {
  const w0 = Math.sqrt(stiffness)
  const zeta = damping / (2 * w0)
  const at = (t) => {
    if (zeta >= 1) return 1 - (1 + w0 * t) * Math.exp(-w0 * t)
    const wd = w0 * Math.sqrt(1 - zeta * zeta)
    return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + (zeta * w0 / wd) * Math.sin(wd * t))
  }
  let end = 0.05
  while (end < 2 && Math.abs(1 - at(end)) > 0.001) end += 0.01
  const points = Array.from({ length: 25 }, (_, index) => (index === 24 ? 1 : at(end * index / 24)).toFixed(4))
  // `progress(ms)` is the same curve for a glide a script drives frame by frame, one
  // that follows a target moving as it goes; it reads 1 once `duration` has passed.
  const duration = Math.round(end * 1000)
  const progress = ms => (ms >= duration ? 1 : ms <= 0 ? 0 : at(ms / 1000))
  return { duration, easing: `linear(${points.join(',')})`, stiffness, damping, progress }
}

// The capsule's two springs: a gentle one (ω=20, ζ=0.78) reshapes surfaces, a
// tighter one (ω=30, ζ=0.8) answers the press.
export const SPRING_SHAPE = springEasing(400, 31.2)
export const SPRING_TAP = springEasing(900, 48)
// Rows of a list move to new places on ω=22, ζ=0.8.
export const SPRING_LIST = springEasing(484, 35.2)
// A looser spring (ω≈18, ζ≈0.56) that overshoots a little, for a surface that stretches
// open, and a quicker one for a mark that pops in.
export const SPRING_STRETCH = springEasing(320, 20)
export const SPRING_POP = springEasing(500, 22)
// A thumb's two edges: the one in front runs the fast spring (ω=28), the one behind
// the slower one (ω=17), so the thumb stretches into the move and settles behind it
// within about a quarter second.
export const SPRING_LEAD = springEasing(784, 48.2)
export const SPRING_TRAIL = springEasing(289, 29.2)
// Critically damped layout glide (ω≈31.6, ζ=1) for sidebar row reordering.
export const SPRING_GLIDE = springEasing(1000, 63)
// A highlight that follows the keyboard and pointer down a list keeps up on stiffer
// edges (ω=30 and ω=20).
export const QUICK_EDGES = { lead: springEasing(900, 51), trail: springEasing(400, 34) }

export const spring = (curve, ...properties) => properties.map(property => `${property} ${curve.duration}ms ${curve.easing}`).join(',')

// Springs stepped once per frame. A new target keeps the current velocity, so a thumb
// that is sent somewhere else mid-move turns smoothly instead of starting over. Each
// frame covers the whole time since the last one, like a CSS transition, so a busy
// page delays the thumb instead of slowing it down.
function liveSprings(apply) {
  const values = new Map()
  const current = {}
  let frame = 0
  let last = 0
  const step = (now) => {
    const dt = Math.min(0.5, Math.max(0.001, (now - last) / 1000))
    last = now
    const steps = Math.ceil(dt * 240)
    const h = dt / steps
    let moving = false
    for (const [key, value] of values) {
      for (let index = 0; index < steps; index += 1) {
        value.v += (-value.k * (value.x - value.to) - value.c * value.v) * h
        value.x += value.v * h
      }
      if (Math.abs(value.x - value.to) < 0.05 && Math.abs(value.v) < 1) { value.x = value.to; value.v = 0 } else moving = true
      current[key] = value.x
    }
    apply(current)
    frame = moving ? requestAnimationFrame(step) : 0
  }
  return {
    target: () => {
      if (!values.size) return null
      const out = {}
      for (const [key, value] of values) out[key] = value.to
      return out
    },
    set(targets, curves, jump) {
      for (const [key, to] of Object.entries(targets)) {
        const value = values.get(key)
        const { stiffness: k, damping: c } = curves[key]
        if (!value || jump) { values.set(key, { x: to, v: 0, to, k, c }); current[key] = to }
        else Object.assign(value, { to, k, c })
      }
      if (jump) { cancelAnimationFrame(frame); frame = 0; apply(current); return }
      if (!frame) { last = performance.now(); frame = requestAnimationFrame(step) }
    },
    reset: () => { values.clear(); for (const key of Object.keys(current)) delete current[key]; cancelAnimationFrame(frame); frame = 0 },
    stop: () => { cancelAnimationFrame(frame); frame = 0 },
  }
}

const CHOSEN = '[aria-pressed="true"],[aria-selected="true"],[aria-current="page"]'

// One thumb for a row, column, or wrapped grid of choices that glides to the chosen one.
// Attach `box` to the positioned container and `thumb` to an absolutely placed child;
// the thumb appears in place with a new box, then springs on every change of `key`. The
// box gets data-glide once the thumb is placed, so its CSS can drop the chosen item's
// own fill. `selector` finds the chosen item; with none the thumb gets data-hidden.
// `axis: 'both'` tracks full 2D geometry (x, y, width, height) for wrapping tracks.
// `box` takes a ref the caller already holds for the container.
export function useGlide(key, { axis = 'x', selector = CHOSEN, lead = SPRING_LEAD, trail = SPRING_TRAIL, box: given, syncKey } = {}) {
  const ownBox = useRef(null)
  const box = given ?? ownBox
  const thumb = useRef(null)
  const own = useRef(null)
  if (own.current === null) {
    own.current = {
      key: undefined, syncKey: undefined, axis, node: null, observer: null,
      springs: liveSprings((values) => {
        const knob = thumb.current
        if (!knob) return
        const currentAxis = own.current.axis
        if (currentAxis === 'both') {
          knob.style.transform = `translate3d(${values.x0}px,${values.y0}px,0)`
          knob.style.width = `${Math.max(0, values.x1 - values.x0)}px`
          knob.style.height = `${Math.max(0, values.y1 - values.y0)}px`
          return
        }
        knob.style.transform = currentAxis === 'x' ? `translateX(${values.start}px)` : `translateY(${values.start}px)`
        knob.style[currentAxis === 'x' ? 'width' : 'height'] = `${Math.max(0, values.end - values.start)}px`
      }),
    }
  }
  // `jump` places without motion, and only when the chosen item moved: a box that
  // resizes while the thumb is under way does not cut the glide short.
  const place = (jump) => {
    const container = box.current
    const knob = thumb.current
    if (!container || !knob) return
    const currentAxis = own.current.axis
    const chosen = container.querySelector(selector)
    if (!chosen) { knob.dataset.hidden = ''; return }
    const { springs } = own.current
    const before = springs.target()
    const hidden = knob.dataset.hidden !== undefined
    if (currentAxis === 'both') {
      const x0 = chosen.offsetLeft
      const x1 = x0 + chosen.offsetWidth
      const y0 = chosen.offsetTop
      const y1 = y0 + chosen.offsetHeight
      if (jump && !hidden && before?.x0 === x0 && before?.x1 === x1 && before?.y0 === y0 && before?.y1 === y1 && container.dataset.glide !== undefined) return
      delete knob.dataset.hidden
      const forwardX = before === null || x0 >= before.x0
      const forwardY = before === null || y0 >= before.y0
      springs.set(
        { x0, x1, y0, y1 },
        {
          x0: forwardX ? trail : lead,
          x1: forwardX ? lead : trail,
          y0: forwardY ? trail : lead,
          y1: forwardY ? lead : trail,
        },
        jump || hidden || before === null || reducedMotion(),
      )
      container.dataset.glide = ''
      return
    }
    const start = currentAxis === 'x' ? chosen.offsetLeft : chosen.offsetTop
    const end = start + (currentAxis === 'x' ? chosen.offsetWidth : chosen.offsetHeight)
    if (jump && !hidden && before?.start === start && before?.end === end && container.dataset.glide !== undefined) return
    delete knob.dataset.hidden
    const forward = before === null || start >= before.start
    springs.set({ start, end }, forward ? { start: trail, end: lead } : { start: lead, end: trail }, jump || hidden || before === null || reducedMotion())
    container.dataset.glide = ''
  }
  useLayoutEffect(() => {
    const state = own.current
    const node = box.current
    const axisChanged = axis !== state.axis
    const syncChanged = syncKey !== state.syncKey
    if (node === state.node && key === state.key && !axisChanged && !syncChanged) return
    const keyChanged = key !== state.key
    const fresh = node !== state.node || axisChanged || (!keyChanged && syncChanged)
    state.key = key
    state.syncKey = syncKey
    if (axisChanged) {
      state.axis = axis
      state.springs.reset()
      if (thumb.current) {
        thumb.current.style.transform = ''
        thumb.current.style.width = ''
        thumb.current.style.height = ''
      }
    }
    if (node !== state.node) {
      state.observer?.disconnect()
      if (!node) state.springs.stop()
      state.node = node
      state.observer = node && typeof ResizeObserver === 'function' ? new ResizeObserver(() => place(true)) : null
      state.observer?.observe(node)
    }
    place(fresh)
  })
  useEffect(() => () => { own.current.observer?.disconnect(); own.current.observer = null; own.current.node = null; own.current.springs.stop() }, [])
  return { box, thumb, sync: () => place(true) }
}

const segButtons = node => Array.from(node.children).filter(child => child.tagName === 'BUTTON' && !child.hidden)
// Checks only the buttons' own geometry — never `node.scrollWidth` — because a gliding
// `.bt-thumb` still positioned at an earlier wider layout would otherwise trigger a false
// overflow when shrinking back down.
function segOverflow(node, buttons) {
  const style = typeof getComputedStyle === 'function' ? getComputedStyle(node) : null
  const padLeft = parseFloat(style?.paddingLeft) || 0
  const padRight = parseFloat(style?.paddingRight) || 0
  const rightEdge = node.clientWidth - padRight + 1
  return buttons.some(button => button.scrollWidth > button.clientWidth + 1
    || button.offsetLeft < padLeft - 1
    || button.offsetLeft + button.offsetWidth > rightEdge)
}

// Chooses the tightest balanced layout that keeps every button inside the track without
// splitting words mid-word: single row when it fits, symmetric grid for even/6+ counts,
// wrapped rows for odd counts, and a 1-column stack only when even cells are too narrow.
export function fitSegmented(node) {
  if (!node) return undefined
  const buttons = segButtons(node)
  if (buttons.length <= 1 || node.clientWidth === 0) {
    delete node.dataset.layout
    return undefined
  }
  // Reset synchronously before paint to test whether the natural single row fits again.
  delete node.dataset.layout
  if (!segOverflow(node, buttons)) return undefined
  const count = buttons.length
  const candidates = []
  if (count >= 6 && count % 3 === 0) candidates.push('grid-3')
  if (count === 2 || (count >= 4 && count % 2 === 0)) candidates.push('grid-2')
  else if (count > 2) candidates.push('wrap')
  candidates.push('stack')
  for (const layout of candidates) {
    node.dataset.layout = layout
    if (!segOverflow(node, buttons)) return layout
  }
  return node.dataset.layout
}

// Buttons side by side (or in a responsive grid when narrow) over one thumb that glides
// to the pressed one (aria-pressed).
export function Segmented({ label, value, className, children }) {
  const box = useRef(null)
  const fitRef = useRef({ sig: null, parentW: -1, rowW: -1, nodeW: -1, observer: null, node: null })
  const syncThumb = useRef(null)

  const reconcile = (force = false) => {
    const node = box.current
    if (!node) return
    const state = fitRef.current
    const buttons = segButtons(node)
    const cs = typeof getComputedStyle === 'function' ? getComputedStyle(buttons[0] ?? node) : null
    const font = cs ? `${cs.fontWeight}\u0000${cs.fontSize}\u0000${cs.fontFamily}` : ''
    const sig = `${font}\u0000${buttons.map(button => button.textContent).join('\u0000')}`
    const parent = node.parentElement
    const row = typeof node.closest === 'function' ? node.closest('.bt-set-row') : null
    const parentW = parent?.clientWidth ?? -1
    const rowW = row?.clientWidth ?? -1
    const nodeW = node.clientWidth
    if (!force && sig === state.sig && parentW === state.parentW && rowW === state.rowW && nodeW === state.nodeW) return
    fitSegmented(node)
    state.sig = sig
    state.parentW = parent?.clientWidth ?? -1
    state.rowW = row?.clientWidth ?? -1
    state.nodeW = node.clientWidth
    syncThumb.current?.()
  }

  useLayoutEffect(() => {
    const node = box.current
    const state = fitRef.current
    if (node !== state.node) {
      state.observer?.disconnect()
      state.node = node
      state.sig = null
      if (node && typeof ResizeObserver === 'function') {
        const observer = new ResizeObserver(() => reconcile(false))
        observer.observe(node)
        if (node.parentElement) observer.observe(node.parentElement)
        const row = typeof node.closest === 'function' ? node.closest('.bt-set-row') : null
        if (row && row !== node.parentElement) observer.observe(row)
        state.observer = observer
      } else {
        state.observer = null
      }
    }
    reconcile(false)
  })
  useEffect(() => {
    let alive = true
    const fonts = typeof document !== 'undefined' ? document.fonts : null
    if (fonts && fonts.status !== 'loaded' && fonts.ready) {
      void fonts.ready.then(() => { if (alive) reconcile(true) }, () => {})
    }
    return () => { alive = false; fitRef.current.observer?.disconnect(); fitRef.current.observer = null; fitRef.current.node = null }
  }, [])

  const glide = useGlide(value, { axis: 'both', box })
  syncThumb.current = glide.sync
  return h('div', { ref: box, className: className ? `bt-seg ${className}` : 'bt-seg', role: 'group', 'aria-label': label },
    h('span', { ref: glide.thumb, className: 'bt-thumb', 'aria-hidden': true }), children)
}

// Children of `list` matching `selector` slide from where they were to where a change of
// `key` put them, on SPRING_LIST, and children that were not there before clear from a
// blur; `id` names a child across renders. offsetTop ignores transforms, so a slide in
// flight does not skew the next one.
export function useFlip(list, key, selector, id = node => node.dataset.flip) {
  const tops = useRef(null)
  useLayoutEffect(() => {
    const container = list.current
    if (!container) return
    const next = new Map()
    const moving = tops.current !== null && !reducedMotion()
    for (const node of container.querySelectorAll(selector)) {
      const name = id(node)
      const top = node.offsetTop
      next.set(name, top)
      if (!moving) continue
      const before = tops.current.get(name)
      if (before === undefined) {
        const noBlur = reducedEffects()
        node.animate([noBlur ? { opacity: 0 } : { opacity: 0, filter: 'blur(4px)' }, noBlur ? { opacity: 1 } : { opacity: 1, filter: 'blur(0)' }], { duration: 180, easing: 'ease-out' })
      } else if (Math.abs(before - top) > 0.5) {
        node.animate([{ transform: `translateY(${before - top}px)` }, { transform: 'none' }], { duration: SPRING_LIST.duration, easing: SPRING_LIST.easing })
      }
    }
    tops.current = next
  }, [key])
}

// `box` changes height on SPRING_SHAPE when a change of `key` changes its content, so
// a surface reshapes around what it holds instead of jumping. A change that comes
// mid-morph starts from the height on screen. The box clips its content meanwhile.
// The resting height comes from a ResizeObserver: reading it on every render would lay
// out the page once per render, the panel's whole first frame when it opens.
export function useMorph(box, key, { width: morphWidth = false, curve = SPRING_SHAPE } = {}) {
  const last = useRef({ key, height: null, width: null, node: null, observer: null })
  useLayoutEffect(() => {
    const node = box.current
    const state = last.current
    if (node !== state.node) {
      state.observer?.disconnect()
      Object.assign(state, {
        key,
        height: node ? node.offsetHeight : null,
        width: node ? node.offsetWidth : null,
        node,
        observer: null,
      })
      if (!node || typeof ResizeObserver !== 'function') return
      state.observer = new ResizeObserver(([entry]) => {
        if (node.dataset.morph === undefined) {
          state.height = entry.borderBoxSize?.[0]?.blockSize ?? node.offsetHeight
          state.width = entry.borderBoxSize?.[0]?.inlineSize ?? node.offsetWidth
        }
      })
      state.observer.observe(node)
      return
    }
    if (!node || key === state.key) return
    const running = node.getAnimations().filter(animation => animation.id === 'bt-morph')
    const fromH = running.length ? node.offsetHeight : state.height
    const fromW = running.length ? node.offsetWidth : state.width
    for (const animation of running) animation.cancel()
    delete node.dataset.morph
    const toH = node.offsetHeight
    const toW = node.offsetWidth
    Object.assign(state, { key, height: toH, width: toW })
    const dh = fromH !== null && Math.abs(fromH - toH) >= 1
    const dw = morphWidth && fromW !== null && Math.abs(fromW - toW) >= 1
    if ((!dh && !dw) || reducedEffects()) return
    const start = {}
    const end = {}
    if (dh) { start.height = `${fromH}px`; end.height = `${toH}px` }
    if (dw) { start.width = `${fromW}px`; end.width = `${toW}px` }
    node.dataset.morph = ''
    const animation = node.animate([start, end], { duration: curve.duration, easing: curve.easing, id: 'bt-morph' })
    animation.onfinish = () => { delete node.dataset.morph }
    animation.oncancel = () => { if (!node.getAnimations().some(other => other.id === 'bt-morph' && other !== animation)) delete node.dataset.morph }
  })
  useEffect(() => () => last.current.observer?.disconnect(), [])
}

// The last truthy `value` for `ms` after it turns falsy, so a closing layer can play its
// exit; `leaving` is true meanwhile.
export function useLinger(value, ms) {
  const [kept, setKept] = useState(value)
  useEffect(() => {
    if (value) { setKept(value); return undefined }
    const timer = setTimeout(() => setKept(value), reducedMotion() ? 0 : ms)
    return () => clearTimeout(timer)
  }, [value])
  return [value || kept, !value && Boolean(kept)]
}

// Moves keyboard focus through enabled menu items on ArrowDown, ArrowUp, Home and End.
export function stepMenuFocus(menu, event, trigger) {
  if (!menu || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return false
  const items = Array.from(menu.querySelectorAll('button[role^="menuitem"]:not(:disabled)'))
  if (items.length === 0) return false
  const target = document.activeElement
  const current = items.indexOf(target)
  if (current === -1 && target !== menu && target !== trigger) return false
  event.preventDefault()
  event.stopPropagation()
  const next = event.key === 'Home' ? 0
    : event.key === 'End' ? items.length - 1
      : event.key === 'ArrowDown' ? (current + 1) % items.length
        : (current <= 0 ? items.length - 1 : current - 1)
  items[next]?.focus()
  return true
}
