// An infinite animation keeps the window drawing a frame every vsync for as long as it
// runs, whether anyone sees it or not. A single small loop costs a good part of a core
// between the renderer and the GPU, and a working Bot's mark scrolled out of the sidebar
// costs as much as one in view (#1462). So a loop runs only while it can be seen moving:
// the page is shown, someone touched the window within REST_MS, and its element is in
// view. Finite animations (a dialog rising, a mark settling) always play out.

/** How long the window may go untouched before its loops hold still. */
export const REST_MS = 30_000

const INPUTS = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart']
const CHANGES = ['animationstart', 'animationcancel', 'animationend']

const isLoop = animation => animation?.effect?.getTiming?.().iterations === Infinity
// A part of an SVG drawing (a mark's eyes inside its mask) may have no box of its own; the
// drawing it belongs to is what scrolls in and out of view.
const boxOf = (target) => {
  let element = target ?? null
  while (element?.ownerSVGElement) element = element.ownerSVGElement
  return element
}

/**
 * Pauses the page's infinite animations while nobody can see them and plays them again
 * when someone can. Only loops this paused are played again; one paused by its own code
 * stays as it was.
 * @param {{ doc?: Document, win?: Window, restMs?: number, now?: () => number }} [options]
 * @returns {() => void} undoes everything and plays the loops it holds
 */
export function installMotionRest({ doc = document, win = window, restMs = REST_MS, now = () => Date.now() } = {}) {
  if (typeof doc?.getAnimations !== 'function') return () => {}
  const loops = new Map()
  const held = new Set()
  const watched = new Map()
  const inView = new WeakMap()
  let last = now()
  let resting = doc.hidden === true
  let timer = 0
  let queued = false
  let stopped = false

  const runs = animation => !resting && inView.get(loops.get(animation)) !== false
  const apply = () => {
    for (const animation of loops.keys()) {
      if (runs(animation)) {
        if (held.delete(animation) && animation.playState === 'paused') animation.play()
      } else if (animation.playState === 'running') {
        animation.pause()
        held.add(animation)
      }
    }
  }
  const observer = typeof win.IntersectionObserver === 'function'
    ? new win.IntersectionObserver((entries) => {
      for (const entry of entries) inView.set(entry.target, entry.isIntersecting)
      apply()
    })
    : null
  const watch = (element) => {
    const count = watched.get(element) ?? 0
    watched.set(element, count + 1)
    if (count === 0) observer?.observe(element)
  }
  const unwatch = (element) => {
    const count = (watched.get(element) ?? 1) - 1
    if (count > 0) { watched.set(element, count); return }
    watched.delete(element)
    inView.delete(element)
    observer?.unobserve(element)
  }
  const sync = () => {
    queued = false
    if (stopped) return
    const current = new Set(doc.getAnimations().filter(isLoop))
    for (const [animation, element] of loops) {
      if (current.has(animation)) continue
      loops.delete(animation)
      // A held loop that became finite (effects turned down) still has to play out.
      if (held.delete(animation) && animation.playState === 'paused') animation.play()
      if (element) unwatch(element)
    }
    for (const animation of current) {
      if (loops.has(animation)) continue
      const element = boxOf(animation.effect?.target)
      loops.set(animation, element)
      if (element) watch(element)
    }
    apply()
  }
  const later = () => {
    if (queued) return
    queued = true
    void Promise.resolve().then(sync)
  }
  const check = () => {
    timer = 0
    const left = last + restMs - now()
    if (left > 0) { timer = win.setTimeout(check, left); return }
    // A loop started from script sends no animation event; the rest looks for it anew.
    resting = true
    sync()
  }
  const touch = () => {
    last = now()
    if (!timer) timer = win.setTimeout(check, restMs)
    if (resting && doc.hidden !== true) {
      resting = false
      sync()
    }
  }
  const shown = () => {
    if (doc.hidden === true) {
      resting = true
      sync()
    } else touch()
  }

  for (const type of INPUTS) win.addEventListener(type, touch, { capture: true, passive: true })
  win.addEventListener('focus', touch)
  doc.addEventListener('visibilitychange', shown)
  for (const type of CHANGES) doc.addEventListener(type, later, true)
  timer = win.setTimeout(check, restMs)
  sync()

  return () => {
    stopped = true
    for (const type of INPUTS) win.removeEventListener(type, touch, { capture: true })
    win.removeEventListener('focus', touch)
    doc.removeEventListener('visibilitychange', shown)
    for (const type of CHANGES) doc.removeEventListener(type, later, true)
    if (timer) win.clearTimeout(timer)
    observer?.disconnect()
    for (const animation of held) if (animation.playState === 'paused') animation.play()
    held.clear()
    loops.clear()
    watched.clear()
  }
}
