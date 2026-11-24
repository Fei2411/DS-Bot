import { Avatar } from './engine.js'
import { rigFor, rigJob, rigReady } from './rig.js'
import { drawShapes, shapesOf } from './render.js'
import { GRADIENTS, INKS, isHex } from '../inks.js'
import { REST_MS } from '../motion-rest.js'

// Live marks in the page: a canvas over the mark's flat art, drawn by one shared clock.
//
// One set of listeners serves every mark: input (for resting and for marks that follow
// the pointer), page visibility, which marks are in view, and the motion settings.
// The clock only asks for frames while some mark moves. A mark at rest sleeps until its
// next blink or fidget; a mark out of view, or in a hidden page, is skipped. When
// nobody has touched the window for REST_MS (as for the page's other loops,
// motion-rest.js), marks finish what they are doing and hold still; after DOZE_MS a
// lively mark at rest nods off, and wakes on input.

export const DOZE_MS = 150_000
// The canvas reaches past the mark on each side, so hops and spins are not cut off.
export const MARGIN = 0.3

const marks = new Set()
let frame = 0
let timer = 0
let lastInput = typeof performance === 'undefined' ? 0 : performance.now()
let resting = false
let dozing = false
let watching = false
let restTimer = 0
let observer = null
let themeObserver = null
let themeEpoch = 0
// The pointer, for marks that follow it: a new position is read on the next frame.
let pointer = null
let aimed = true
let followers = 0

// Motion settings come from the page: `data-bt-motion` (quiet, normal, lively) and
// the interface effects level, or the system's reduced-motion request.
export function motionSettings(doc = document) {
  const body = doc.body
  const tier = body?.dataset?.btMotion
  const effects = body?.dataset?.btEffects || doc.documentElement?.dataset?.btEffects
  const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  return {
    tier: tier === 'quiet' || tier === 'lively' ? tier : 'normal',
    effects: reduce || effects === 'off' ? 'off' : effects === 'reduced' ? 'reduced' : 'full',
  }
}

function now() { return performance.now() }

function kick() {
  if (frame || marks.size === 0) return
  if (timer) { clearTimeout(timer); timer = 0 }
  frame = requestAnimationFrame(loop)
}

function loop(time) {
  frame = 0
  let soonest = Infinity
  const hidden = document.hidden === true
  if (!aimed && !hidden) aim()
  for (const mark of marks) {
    if (hidden || !mark.visible) continue
    soonest = Math.min(soonest, mark.step(time))
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

function onSettings() {
  const settings = motionSettings()
  themeEpoch += 1
  aimed = false
  for (const mark of marks) { mark.engine.setOptions(settings); mark.dirty = true }
  kick()
}

const INPUTS = ['pointerdown', 'keydown', 'wheel', 'touchstart']

function watch() {
  if (watching) return
  watching = true
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
    themeObserver = new MutationObserver(onSettings)
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'data-bt-motion', 'data-bt-effects', 'data-bt-theme', 'style', 'class'] })
  }
  window.matchMedia?.('(prefers-reduced-motion: reduce)').addEventListener?.('change', onSettings)
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
  themeObserver?.disconnect()
  themeObserver = null
  window.matchMedia?.('(prefers-reduced-motion: reduce)').removeEventListener?.('change', onSettings)
  if (frame) cancelAnimationFrame(frame)
  if (timer) clearTimeout(timer)
  frame = 0
  timer = 0
}

// Rigs take tens of milliseconds to build, so they are built in slices in idle
// moments, one shape at a time; until a mark's rig is ready it shows its flat art,
// which is the same pose.
const queue = []
let job = null
let building = false
function buildSoon(mark) {
  if (!queue.includes(mark)) queue.push(mark)
  if (building) return
  building = true
  const idle = window.requestIdleCallback ?? (fn => setTimeout(() => fn({ timeRemaining: () => 6 }), 16))
  const work = (deadline) => {
    while (deadline.timeRemaining() > 2) {
      const mark = queue[0]
      if (!mark) { building = false; job = null; return }
      job ??= rigJob(mark.look.shape, mark.def)
      if (!job()) continue
      job = null
      // Every waiting mark of this shape can take the rig now.
      for (const waiting of queue.filter(other => rigReady(other.look.shape, other.def))) {
        queue.splice(queue.indexOf(waiting), 1)
        if (marks.has(waiting)) waiting.attachRig()
      }
    }
    idle(work)
  }
  idle(work)
}

// A mark with nothing to turn (an uploaded photo, a shape another plugin draws) moves
// as a whole: hops, squash, lean, and a turn that narrows it like a coin.
export function flatTransform(frame) {
  const sy = 1 - Math.max(-0.4, Math.min(0.4, frame.sq))
  const s = 1 + frame.scale
  const turn = Math.max(0.15, Math.abs(Math.cos((frame.yaw * Math.PI) / 180)))
  return `translate(${frame.x.toFixed(2)}%,${frame.y.toFixed(2)}%) rotate(${(frame.roll * 0.6).toFixed(2)}deg) scale(${(s * turn / sy).toFixed(4)},${(s * sy).toFixed(4)})`
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
    this.drawnAt = 0
    this.rig = undefined
    this.inkEpoch = -1
    this.wantsCanvas = canvas
    const settings = motionSettings()
    this.engine = new Avatar({ seed, size, live, state, ...settings })
    if (resting) this.engine.rest(true)
    this.follow = false
    host.__btLive = this
    marks.add(this)
    watch()
    this.setFollow(follow)
    observer?.observe(host)
    if (rigReady(look.shape, def)) this.attachRig()
    else buildSoon(this)
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
      if (this.flat) this.flat.style.transformOrigin = '50% 92%'
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
      this.look = look
      this.def = def
      this.rig = undefined
      this.canvas?.remove()
      this.canvas = null
      this.ctx = null
      if (this.flat) { this.flat.style.transform = ''; this.flat.style.transformOrigin = '' }
      this.flat = null
      delete this.host.dataset.live3d
      if (rigReady(look.shape, def)) this.attachRig()
      else buildSoon(this)
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
    // Small marks draw at most 30 times a second.
    if (this.engine.lod === 'chip' && elapsed < 1 / 31 && !this.dirty) return 1 / 30 - elapsed
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
    else value = getComputedStyle(this.host).getPropertyValue(`--bt-ink-${color}`).trim() || getComputedStyle(this.host).getPropertyValue('--bt-ink-gray').trim() || INKS.gray[0]
    this.inkValue = value
    this.inkEpoch = themeEpoch
    return value
  }

  draw() {
    this.dirty = false
    if (this.flat) { this.flat.style.transform = flatTransform(this.engine.frame); return }
    if (!this.rig || !this.ctx) return
    const ctx = this.ctx
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    ctx.setTransform(this.scale, 0, 0, this.scale, MARGIN * 100 * this.scale, MARGIN * 100 * this.scale)
    drawShapes(ctx, shapesOf(this.rig, this.engine.frame, this.scratch ??= {}), this.ink())
  }

  // Actions, each answered with a frame.
  act(fn) { fn(this.engine); this.dirty = true; kick() }

  destroy() {
    this.setFollow(false)
    marks.delete(this)
    observer?.unobserve(this.host)
    this.canvas?.remove()
    if (this.flat) { this.flat.style.transform = ''; this.flat.style.transformOrigin = '' }
    delete this.host.dataset.live3d
    delete this.host.__btLive
    const at = queue.indexOf(this)
    if (at >= 0) queue.splice(at, 1)
    unwatch()
  }
}
