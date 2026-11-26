import { Avatar } from './engine.js'
import { rigFor, rigJob, rigReady } from './rig.js'
import { drawShapes, shapesOf } from './render.js'
import { GRADIENTS, INKS, inkName, isHex } from '../inks.js'
import { reducedEffects, reducedMotion } from '../effects.js'
import { REST_MS } from '../motion-rest.js'
import { CONFETTI_INKS, DOZE_MS, FLAT_ORIGIN, flatPose, MARGIN } from './stage.js'

// Live marks in the page: a canvas over the mark's flat art, drawn by one shared clock.
//
// One set of listeners serves every mark: input (for resting and for marks that follow
// the pointer), page visibility, which marks are in view, and the motion settings.
// The clock only asks for frames while some mark moves. A mark at rest sleeps until its
// next blink or fidget; a mark out of view, or in a hidden page, is skipped. When
// nobody has touched the window for REST_MS (as for the page's other loops,
// motion-rest.js), marks finish what they are doing and keep only their state's own
// moves, further apart and at 30 fps at most: idle and asleep hold still. After
// DOZE_MS a lively mark at rest nods off, and wakes on input.
//
// A mark shows its flat art until it first leaves the rest pose. Only then is its
// model built (in idle slices) and the canvas put over the art; the move waits for
// the model, so it never starts on the art and jumps.

// DOZE_MS and MARGIN live in stage.js: the phone app's clock shares them.
export { DOZE_MS, MARGIN }

const marks = new Set()
let frame = 0
let timer = 0
let looping = false
let lastInput = typeof performance === 'undefined' ? 0 : performance.now()
let resting = false
let dozing = false
let watching = false
let restTimer = 0
let observer = null
let settingsObserver = null
let reduceQuery = null
// What the settings were when the marks last heard of them; the inks follow the theme.
let shownSettings = ''
let shownDark = null
let themeEpoch = 0
// The pointer, for marks that follow it: a new position is read on the next frame.
let pointer = null
let aimed = true
let followers = 0

// Motion settings come from the page: `data-bt-motion` (quiet, normal, lively) and the
// interface motion level, or the system's reduced-motion request (effects.js).
export function motionSettings() {
  const tier = typeof document === 'undefined' ? undefined : document.body?.dataset?.btMotion
  return {
    tier: tier === 'quiet' || tier === 'lively' ? tier : 'normal',
    effects: reducedMotion() ? 'off' : reducedEffects() ? 'reduced' : 'full',
  }
}

function now() { return performance.now() }

function kick() {
  // Inside the loop the loop itself asks for the next frame.
  if (frame || looping || marks.size === 0) return
  if (timer) { clearTimeout(timer); timer = 0 }
  frame = requestAnimationFrame(loop)
}

function loop(time) {
  frame = 0
  looping = true
  let soonest = Infinity
  const hidden = document.hidden === true
  try {
    if (!aimed && !hidden) aim()
    for (const mark of marks) {
      if (hidden || !mark.visible) continue
      soonest = Math.min(soonest, mark.step(time))
    }
  } finally {
    looping = false
  }
  if (hidden || marks.size === 0) return
  if (soonest <= 0.03) frame = requestAnimationFrame(loop)
  else if (Number.isFinite(soonest)) timer = setTimeout(() => { timer = 0; kick() }, Math.min(soonest * 1000, 60_000))
}

function onPointer(event) {
  onInput()
  if (pointer && pointer.x === event.clientX && pointer.y === event.clientY) return
  pointer = { x: event.clientX, y: event.clientY }
  aimed = false
  if (followers > 0) kick()
}

function onPointerLeave() {
  pointer = null
  aimed = false
  if (followers > 0) kick()
}

// Points every following mark at the pointer, in mark radii from its middle. Reads all
// the boxes first, then moves the engines.
function aim() {
  aimed = true
  const boxes = []
  for (const mark of marks) {
    if (!mark.follow || !mark.visible || !mark.host.isConnected) continue
    if (pointer && !mark.engine.follows) continue
    boxes.push([mark, pointer ? mark.host.getBoundingClientRect() : null])
  }
  for (const [mark, box] of boxes) {
    const r = box ? Math.max(box.width / 2, 1) : 1
    mark.engine.gaze(box && { x: (pointer.x - box.left - r) / r, y: (pointer.y - box.top - box.height / 2) / r })
    mark.dirty = true
  }
}

function onInput() {
  lastInput = now()
  if (resting || dozing) {
    resting = false
    dozing = false
    for (const mark of marks) { mark.engine.rest(false); mark.engine.doze(false); mark.dirty = true }
    kick()
  }
}

function checkRest() {
  const idle = now() - lastInput
  if (!resting && idle >= REST_MS) {
    resting = true
    for (const mark of marks) mark.engine.rest(true)
  }
  if (!dozing && idle >= DOZE_MS) {
    dozing = true
    for (const mark of marks) if (mark.engine.live && mark.engine.tier === 'lively') mark.engine.doze(true)
    kick()
  }
}

function onVisibility() {
  if (!document.hidden) { for (const mark of marks) mark.sync(); kick() }
}

// Only a change the marks show counts: the motion levels, and dark mode for the inks.
function onSettings() {
  const settings = motionSettings()
  const key = `${settings.tier}|${settings.effects}`
  const dark = document.body?.hasAttribute('data-ds-dark-theme') === true
  if (key === shownSettings && dark === shownDark) return
  if (dark !== shownDark) themeEpoch += 1
  shownSettings = key
  shownDark = dark
  aimed = false
  for (const mark of marks) { mark.engine.setOptions(settings); mark.dirty = true }
  kick()
}

const INPUTS = ['pointerdown', 'keydown', 'wheel', 'touchstart']

function watch() {
  if (watching) return
  watching = true
  // No input was heard while no mark was up, and a mark usually comes up because
  // someone just did something: resting starts counting again.
  lastInput = now()
  resting = false
  dozing = false
  const settings = motionSettings()
  shownSettings = `${settings.tier}|${settings.effects}`
  shownDark = document.body?.hasAttribute('data-ds-dark-theme') === true
  window.addEventListener('pointermove', onPointer, { passive: true, capture: true })
  for (const type of INPUTS) window.addEventListener(type, onInput, { passive: true, capture: true })
  document.documentElement.addEventListener('pointerleave', onPointerLeave)
  document.addEventListener('visibilitychange', onVisibility)
  restTimer = setInterval(checkRest, 5000)
  if (typeof IntersectionObserver === 'function') {
    observer = new IntersectionObserver((records) => {
      for (const record of records) {
        const mark = record.target.__btLive
        if (!mark) continue
        mark.visible = record.isIntersecting
        if (mark.visible) { mark.sync(); aimed = false; kick() }
      }
    })
  }
  if (typeof MutationObserver === 'function' && document.body) {
    settingsObserver = new MutationObserver(onSettings)
    settingsObserver.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'data-bt-motion', 'data-bt-effects'] })
    settingsObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-bt-effects'] })
  }
  // The same query object both ways: each matchMedia call returns a new one.
  reduceQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null
  reduceQuery?.addEventListener?.('change', onSettings)
}

function unwatch() {
  if (!watching || marks.size > 0) return
  watching = false
  window.removeEventListener('pointermove', onPointer, { capture: true })
  for (const type of INPUTS) window.removeEventListener(type, onInput, { capture: true })
  document.documentElement.removeEventListener('pointerleave', onPointerLeave)
  document.removeEventListener('visibilitychange', onVisibility)
  pointer = null
  clearInterval(restTimer)
  observer?.disconnect()
  observer = null
  settingsObserver?.disconnect()
  settingsObserver = null
  reduceQuery?.removeEventListener?.('change', onSettings)
  reduceQuery = null
  if (frame) cancelAnimationFrame(frame)
  if (timer) clearTimeout(timer)
  frame = 0
  timer = 0
  stopBuilding()
}

// Rigs take tens of milliseconds to build, so they are built in slices in idle
// moments, for the first waiting mark's shape; until a mark's rig is ready it shows its
// flat art, which is the same pose. A shape whose marks all went is left part-built
// and goes on from there if one comes back.
const queue = []
const jobs = new Map()
let building = false
let idleAsk = null
// A page that is never idle still gets FORCED_MS of building after IDLE_WAIT_MS.
// Without requestIdleCallback, a slice gets a few milliseconds of its own.
const IDLE_WAIT_MS = 300
const FORCED_MS = 5
const idleSoon = (fn) => {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(fn, { timeout: IDLE_WAIT_MS })
    idleAsk = { cancel: () => window.cancelIdleCallback?.(id) }
  } else {
    const id = setTimeout(() => { const start = now(); fn({ timeRemaining: () => Math.max(0, 8 - (now() - start)) }) }, 16)
    idleAsk = { cancel: () => clearTimeout(id) }
  }
}
function stopBuilding() {
  idleAsk?.cancel()
  idleAsk = null
  building = false
  // Nobody is left to wait for a model: what was part-built goes too.
  if (marks.size === 0) jobs.clear()
}
function buildSoon(mark) {
  if (!queue.includes(mark)) queue.push(mark)
  if (building) return
  building = true
  const work = (deadline) => {
    idleAsk = null
    const until = deadline.didTimeout === true ? now() + FORCED_MS : 0
    while (now() < until || deadline.timeRemaining() > 2) {
      const mark = queue[0]
      if (!mark) { stopBuilding(); return }
      const { shape } = mark.look
      let job = jobs.get(shape)
      if (!job) jobs.set(shape, job = rigJob(shape, mark.def))
      if (!job()) continue
      jobs.delete(shape)
      // Every waiting mark of this shape can take the rig now.
      for (const waiting of queue.filter(other => rigReady(other.look.shape, other.def))) {
        queue.splice(queue.indexOf(waiting), 1)
        if (marks.has(waiting)) waiting.attachRig()
      }
    }
    idleSoon(work)
  }
  idleSoon(work)
}

// A mark with nothing to turn moves as a whole (flatPose in stage.js).
export function flatTransform(frame) {
  const { x, y, roll, sx, sy } = flatPose(frame)
  return `translate(${x.toFixed(2)}%,${y.toFixed(2)}%) rotate(${roll.toFixed(2)}deg) scale(${sx.toFixed(4)},${sy.toFixed(4)})`
}

export class LiveMark {
  // host: the mark's element. `look` { shape, color }, `def` its shape (characters.js).
  // `canvas: false` keeps the flat art and moves it as a whole (an uploaded photo).
  // `follow`: the eyes and head follow the pointer.
  constructor(host, { look, def, size, seed, live = false, state = 'idle', canvas = true, follow = false } = {}) {
    this.host = host
    this.look = look
    this.def = def
    this.size = size
    this.visible = true
    this.dirty = true
    this.tickedAt = 0
    this.rig = undefined
    this.inkEpoch = -1
    this.wantsCanvas = canvas
    // Listening first: the window's rest is counted afresh when the first mark comes up.
    watch()
    // The engine starts from the flat art's pose and goes into the state from there,
    // so a state's opening move (a done hop, a call for attention) plays as it appears.
    this.engine = new Avatar({ seed, size, live, state: 'idle', ...motionSettings() })
    if (resting) this.engine.rest(true)
    if (state !== 'idle') this.engine.setState(state)
    this.follow = false
    host.__btLive = this
    marks.add(this)
    this.setFollow(follow)
    observer?.observe(host)
    // A photo has nothing to build; a character builds its model when it first moves.
    if (!canvas) this.attachRig()
    kick()
  }

  attachRig() {
    if (this.rig !== undefined) return
    this.rig = this.wantsCanvas ? rigFor(this.look.shape, this.def) : null
    // A page without a 2D canvas (or a shape with no model) moves the flat art instead.
    const canvas = this.rig ? document.createElement('canvas') : null
    const ctx = canvas?.getContext?.('2d') ?? null
    if (!ctx) this.rig = null
    if (!this.rig) {
      this.flat = this.host.firstElementChild
      if (this.flat) this.flat.style.transformOrigin = FLAT_ORIGIN
      this.dirty = true
      kick()
      return
    }
    canvas.className = 'bt-mark-live'
    canvas.setAttribute('aria-hidden', 'true')
    this.canvas = canvas
    this.ctx = ctx
    this.resize()
    this.host.appendChild(canvas)
    this.host.dataset.live3d = ''
    this.dirty = true
    kick()
  }

  // Back to the flat art, for a new shape; the model is built again when it moves.
  detachRig() {
    this.rig = undefined
    this.canvas?.remove()
    this.canvas = null
    this.ctx = null
    this.scratch = null
    if (this.flat) { this.flat.style.transform = ''; this.flat.style.transformOrigin = '' }
    this.flat = null
    delete this.host.dataset.live3d
    const at = queue.indexOf(this)
    if (at >= 0) queue.splice(at, 1)
  }

  resize() {
    if (!this.canvas) return
    const dpr = Math.min(3, window.devicePixelRatio || 1)
    const box = this.size * (1 + MARGIN * 2)
    const px = Math.round(box * dpr)
    if (this.canvas.width !== px) { this.canvas.width = px; this.canvas.height = px }
    this.canvas.style.width = `${box}px`
    this.canvas.style.height = `${box}px`
    this.canvas.style.left = `${-this.size * MARGIN}px`
    this.canvas.style.top = `${-this.size * MARGIN}px`
    this.scale = px / ((1 + MARGIN * 2) * 100)
    this.dirty = true
  }

  setFollow(on) {
    if (on === this.follow) return
    this.follow = on
    followers += on ? 1 : -1
    if (on) aimed = false
    else this.engine.gaze(null)
    this.dirty = true
  }

  update({ look, def, size, live, state, follow }) {
    if (look && (look.shape !== this.look.shape || def !== this.def)) {
      this.detachRig()
      this.look = look
      this.def = def
      this.inkEpoch = -1
      if (!this.wantsCanvas) this.attachRig()
    } else if (look && look.color !== this.look.color) { this.look = look; this.inkEpoch = -1 }
    if (size !== undefined && size !== this.size) { this.size = size; this.engine.setOptions({ size }); this.resize() }
    if (live !== undefined) this.engine.setOptions({ live })
    if (state !== undefined) this.engine.setState(state)
    if (follow !== undefined) this.setFollow(follow)
    this.dirty = true
    kick()
  }

  // Called by the clock: moves on and draws. Returns seconds until it needs a frame.
  step(time) {
    const elapsed = this.tickedAt ? (time - this.tickedAt) / 1000 : 1 / 60
    // Small marks, and every mark while the window rests, draw at most 30 times a second.
    if ((this.engine.lod === 'chip' || this.engine.resting) && elapsed < 1 / 31 && !this.dirty) return 1 / 30 - elapsed
    // Still on the flat art: time runs on while nothing would move. A move waits for the
    // model; the mark's clock starts again once the model is in (attachRig kicks it).
    if (this.rig === undefined && !(this.engine.atRest && this.engine.wakeIn() > elapsed)) {
      if (!rigReady(this.look.shape, this.def)) { buildSoon(this); this.tickedAt = 0; return Infinity }
      this.attachRig()
    }
    this.tickedAt = time
    const moving = this.engine.tick(elapsed)
    if (moving || this.dirty) this.draw()
    return moving ? 0 : this.engine.wakeIn()
  }

  // The clock skipped this mark (hidden, or out of view); start its time again.
  sync() { this.tickedAt = 0; this.dirty = true }

  ink() {
    if (this.inkEpoch === themeEpoch && this.inkValue) return this.inkValue
    const color = this.look.color
    let value
    if (GRADIENTS[color]) {
      value = this.ctx.createLinearGradient(18, 10, 78, 92)
      for (const [offset, stop] of GRADIENTS[color]) value.addColorStop(offset, stop)
    } else if (isHex(color)) value = color
    else value = getComputedStyle(this.host).getPropertyValue(`--bt-ink-${inkName(color)}`).trim() || INKS[inkName(color)][0]
    this.inkValue = value
    this.inkEpoch = themeEpoch
    return value
  }

  // The colors a spin's confetti mixes with the body's: the theme's inks.
  confetti() {
    if (this.confettiEpoch === themeEpoch && this.confettiValue) return this.confettiValue
    const style = getComputedStyle(this.host)
    this.confettiValue = CONFETTI_INKS.map(name => style.getPropertyValue(`--bt-ink-${name}`).trim() || INKS[name][0])
    this.confettiEpoch = themeEpoch
    return this.confettiValue
  }

  draw() {
    this.dirty = false
    if (this.flat) { this.flat.style.transform = flatTransform(this.engine.frame); return }
    if (!this.rig || !this.ctx) return
    const ctx = this.ctx
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    ctx.setTransform(this.scale, 0, 0, this.scale, MARGIN * 100 * this.scale, MARGIN * 100 * this.scale)
    const shapes = shapesOf(this.rig, this.engine.frame, this.scratch ??= {})
    drawShapes(ctx, shapes, this.ink(), shapes.accent?.kind === 'confetti' ? this.confetti() : undefined)
  }

  // Actions, each answered with a frame.
  act(fn) { fn(this.engine); this.dirty = true; kick() }

  destroy() {
    this.setFollow(false)
    this.detachRig()
    marks.delete(this)
    observer?.unobserve(this.host)
    delete this.host.__btLive
    unwatch()
  }
}
