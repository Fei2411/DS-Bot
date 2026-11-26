import { Avatar } from '../../../../ds-bot/src/client/avatar/engine.js'
import { rigFor, rigJob, rigReady } from '../../../../ds-bot/src/client/avatar/rig.js'
import { shapesOf } from '../../../../ds-bot/src/client/avatar/render.js'
import { DOZE_MS, flatPose } from '../../../../ds-bot/src/client/avatar/stage.js'
import { REST_MS } from '../../../../ds-bot/src/client/motion-rest.js'

// The phone's clock for live marks: the rules of the page's clock (avatar/live.js in
// ds-bot) without a page. One clock serves every mark. It asks for frames only while
// some mark moves; a mark at rest sleeps until its next blink or fidget; a mark not on
// screen, or any mark while the app is in the background, is skipped. When nobody has
// touched the app for REST_MS, marks finish what they are doing and keep only their
// state's own moves, further apart and at 30 fps at most: idle and asleep hold still;
// after DOZE_MS a lively mark at rest nods off, and wakes on input.
//
// A mark shows its flat art until it first leaves the rest pose. Only then is its model
// built, in slices of at most SLICE_MS when the JS thread is idle, and the drawing takes
// over; the move waits for the model, so it never starts on the art and jumps.
//
// Nothing here touches React Native: the host (host.ts) brings frames, timers, the app's
// state and the system's motion setting, so a test can run the clock on its own time.

export type Tier = 'quiet' | 'normal' | 'lively'
export type Effects = 'full' | 'reduced' | 'off'
export interface MotionSettings { tier: Tier; effects: Effects }

// Interactive avatar capabilities allowed by the shared engine under these settings
// (engine.js: poke requires !still && tier !== 'quiet'; pet requires follows).
export function motionCapabilities({ tier, effects }: MotionSettings): { canPoke: boolean; canPet: boolean } {
  if (tier === 'quiet' || effects === 'off') return { canPoke: false, canPet: false }
  return { canPoke: true, canPet: effects === 'full' }
}

export interface Signals {
  // The app came to the front (true) or left it (false).
  shown(on: boolean): void
  // Someone touched the app.
  input(): void
  // The system's reduced-motion setting.
  reduceMotion(on: boolean): void
}

export interface Deadline { timeRemaining(): number; didTimeout?: boolean }

export interface Host {
  now(): number
  frame(fn: () => void): unknown
  cancelFrame(handle: unknown): void
  after(fn: () => void, ms: number): unknown
  cancel(handle: unknown): void
  // Runs `fn` when the JS thread is idle, or after `timeout` ms at the latest. React
  // Native's deadline does not know about frames (it offers up to 50 ms), so a slice
  // still stops at SLICE_MS.
  idle?(fn: (deadline: Deadline) => void, timeout: number): unknown
  cancelIdle?(handle: unknown): void
  // Starts sending the app's signals while some mark is up; returns how to stop.
  listen(signals: Signals): () => void
}

// The engine (avatar/engine.js) as this clock and the marks use it.
export interface Engine {
  readonly lod: 'hero' | 'row' | 'chip'
  readonly state: string
  readonly effects: Effects
  readonly live: boolean
  readonly tier: Tier
  readonly resting: boolean
  readonly atRest: boolean
  readonly frame: Parameters<typeof flatPose>[0]
  setOptions(options: { size?: number; live?: boolean; tier?: Tier; effects?: Effects }): void
  setState(name: string): void
  rest(on: boolean): void
  doze(on: boolean): void
  tick(dt: number): boolean
  wakeIn(): number
  poke(): void
  pet(on: boolean, side?: number): void
}
const Engine = Avatar as unknown as new (options: { seed: number; size: number; live: boolean; state: string; tier: Tier; effects: Effects }) => Engine
type Rig = NonNullable<ReturnType<typeof rigFor>>
export type Shapes = ReturnType<typeof shapesOf>
export type Pose = ReturnType<typeof flatPose>
export type Look = { shape: string; color: string }

// What a mark shows on a frame: the turned model's shapes, or the flat art moved as a
// whole (a photo, a shape with no model).
export type Picture = { shapes: Shapes; pose?: undefined } | { pose: Pose; shapes?: undefined }

// A build slice runs at most this long, so frames and touches keep coming between them.
export const SLICE_MS = 4
// Without idle callbacks, slices go a frame apart.
export const SLICE_GAP_MS = 16
// A thread that is never idle still gets a slice after this long.
export const IDLE_WAIT_MS = 300
// The longest a resting clock sleeps before it looks again.
const LONGEST_SLEEP_MS = 60_000

export interface MarkOptions {
  look: Look
  // The shape's definition (characters.js shapeOf); undefined for a photo.
  def?: unknown
  size: number
  seed: number
  live?: boolean
  state?: string
  // false: nothing to turn (a photo); the flat art moves as a whole.
  turns?: boolean
  visible?: boolean
  // Called with each new picture; null goes back to the flat art.
  paint(picture: Picture | null): void
}

export class Clock {
  readonly host: Host
  readonly marks = new Set<LiveMark>()
  private frameHandle: unknown = null
  private timer: unknown = null
  private looping = false
  private shown = true
  private lastInput = 0
  private resting = false
  private dozing = false
  private restTimer: unknown = null
  private unlisten: (() => void) | null = null
  private prefs: { motion?: string; effects?: string } = {}
  private reduce = false
  private readonly settingsListeners = new Set<() => void>()
  // Model building: marks waiting for their shape's model, and part-built models.
  private readonly queue: LiveMark[] = []
  private readonly jobs = new Map<string, () => boolean>()
  private building: unknown = null

  constructor(host: Host) {
    this.host = host
  }

  // The motion levels: the computer's own (prefs.motion, prefs.effects) with the
  // system's reduced-motion request, as on the desktop (avatar/live.js motionSettings).
  get settings(): MotionSettings {
    const { motion, effects } = this.prefs
    return {
      tier: motion === 'quiet' || motion === 'lively' ? motion : 'normal',
      effects: effects === 'off' || this.reduce ? 'off' : effects === 'reduced' ? 'reduced' : 'full',
    }
  }

  get isResting() { return this.resting }
  get isDozing() { return this.dozing }

  setPrefs(prefs: { motion?: string; effects?: string } | undefined) {
    const before = this.settingsKey()
    this.prefs = { motion: prefs?.motion, effects: prefs?.effects }
    this.applySettings(before)
  }

  subscribeSettings(listener: () => void): () => void {
    this.settingsListeners.add(listener)
    return () => { this.settingsListeners.delete(listener) }
  }

  // ---- Signals.
  private readonly signals: Signals = {
    shown: (on) => {
      if (on === this.shown) return
      this.shown = on
      if (!on) { this.stopFrames(); this.pauseBuilding(); return }
      for (const mark of this.marks) mark.sync()
      // Coming back to the app is someone looking at it.
      this.signals.input()
      this.resumeBuilding()
      this.kick()
    },
    input: () => {
      this.lastInput = this.host.now()
      if (this.resting || this.dozing) {
        this.resting = false
        this.dozing = false
        for (const mark of this.marks) { mark.engine.rest(false); mark.engine.doze(false); mark.dirty = true }
        // The timer was set for the doze; resting comes first again.
        if (this.restTimer !== null) { this.host.cancel(this.restTimer); this.restTimer = null }
        this.kick()
      }
      this.watchRest()
    },
    reduceMotion: (on) => {
      const before = this.settingsKey()
      this.reduce = on
      this.applySettings(before)
    },
  }
  private settingsKey() { const { tier, effects } = this.settings; return `${tier}|${effects}` }
  private applySettings(before: string) {
    if (this.settingsKey() === before) return
    const settings = this.settings
    for (const mark of this.marks) { mark.engine.setOptions(settings); mark.dirty = true }
    for (const listener of this.settingsListeners) listener()
    this.kick()
  }

  // ---- Marks coming and going.
  add(mark: LiveMark) {
    if (this.marks.size === 0) {
      // No input was heard while no mark was up, and a mark usually comes up because
      // someone just did something: resting starts counting again.
      this.lastInput = this.host.now()
      this.resting = false
      this.dozing = false
      this.unlisten = this.host.listen(this.signals)
    }
    this.marks.add(mark)
    this.watchRest()
  }

  remove(mark: LiveMark) {
    this.marks.delete(mark)
    const at = this.queue.indexOf(mark)
    if (at >= 0) this.queue.splice(at, 1)
    if (this.marks.size > 0) return
    this.unlisten?.()
    this.unlisten = null
    this.stopFrames()
    if (this.restTimer !== null) { this.host.cancel(this.restTimer); this.restTimer = null }
    this.pauseBuilding()
    // Nobody is left to wait for a model: what was part-built goes too.
    this.jobs.clear()
    this.queue.length = 0
  }

  // ---- Frames.
  kick() {
    // Inside the loop the loop itself asks for the next frame.
    if (this.frameHandle !== null || this.looping || this.marks.size === 0 || !this.shown) return
    if (this.timer !== null) { this.host.cancel(this.timer); this.timer = null }
    this.frameHandle = this.host.frame(this.loop)
  }

  private readonly loop = () => {
    this.frameHandle = null
    if (!this.shown) return
    this.looping = true
    let soonest = Infinity
    const time = this.host.now()
    try {
      for (const mark of this.marks) {
        if (!mark.visible) continue
        soonest = Math.min(soonest, mark.step(time))
      }
    } finally {
      this.looping = false
    }
    if (!this.shown || this.marks.size === 0) return
    if (soonest <= 0.03) this.frameHandle = this.host.frame(this.loop)
    else if (Number.isFinite(soonest)) this.timer = this.host.after(() => { this.timer = null; this.kick() }, Math.min(soonest * 1000, LONGEST_SLEEP_MS))
  }

  private stopFrames() {
    if (this.frameHandle !== null) this.host.cancelFrame(this.frameHandle)
    if (this.timer !== null) this.host.cancel(this.timer)
    this.frameHandle = null
    this.timer = null
  }

  // ---- Resting. One timer, set for the next time something could change; an input in
  // between only moves `lastInput`, and the timer looks again when it fires.
  private watchRest() {
    if (this.restTimer !== null || this.marks.size === 0) return
    const idle = this.host.now() - this.lastInput
    const next = !this.resting ? REST_MS : !this.dozing ? DOZE_MS : Infinity
    if (!Number.isFinite(next)) return
    this.restTimer = this.host.after(() => { this.restTimer = null; this.checkRest() }, Math.max(0, next - idle))
  }

  private checkRest() {
    const idle = this.host.now() - this.lastInput
    if (!this.resting && idle >= REST_MS) {
      this.resting = true
      for (const mark of this.marks) mark.engine.rest(true)
    }
    if (!this.dozing && idle >= DOZE_MS) {
      this.dozing = true
      for (const mark of this.marks) if (mark.engine.live && mark.engine.tier === 'lively') mark.engine.doze(true)
      this.kick()
    }
    this.watchRest()
  }

  // ---- Building models. Rigs take tens of milliseconds to build (more on a phone), so
  // they are built in slices, for the first waiting mark's shape; until a mark's rig is
  // ready it shows its flat art, which is the same pose. A shape whose marks all went is
  // left part-built and goes on from there if one comes back.
  buildSoon(mark: LiveMark) {
    if (!this.queue.includes(mark)) this.queue.push(mark)
    if (this.building === null && this.shown) this.sliceSoon(0)
  }

  // A mark off screen, or back on its flat art, waits for nothing: the build goes on for
  // the marks on screen (the phone's idle time comes whenever the thread is free, so a
  // build nobody sees would take it all). Part-built models are kept.
  unqueue(mark: LiveMark) {
    const at = this.queue.indexOf(mark)
    if (at < 0) return
    this.queue.splice(at, 1)
    if (this.queue.length === 0) this.pauseBuilding()
  }

  private sliceSoon(gap: number) {
    this.building = this.host.idle ? this.host.idle(this.slice, IDLE_WAIT_MS) : this.host.after(() => this.slice(), gap)
  }

  private readonly slice = (deadline?: Deadline) => {
    this.building = null
    const budget = !deadline || deadline.didTimeout ? SLICE_MS : Math.min(SLICE_MS, deadline.timeRemaining())
    const until = this.host.now() + budget
    while (this.host.now() < until) {
      const mark = this.queue[0]
      if (!mark) return
      const { shape } = mark.look
      let job = this.jobs.get(shape)
      if (!job) this.jobs.set(shape, job = rigJob(shape, mark.def) as () => boolean)
      if (!job()) continue
      this.jobs.delete(shape)
      // Every waiting mark of this shape can take the rig now.
      for (const waiting of this.queue.filter(other => rigReady(other.look.shape, other.def))) {
        this.queue.splice(this.queue.indexOf(waiting), 1)
        if (this.marks.has(waiting)) waiting.attachRig()
      }
    }
    if (this.queue.length > 0 && this.shown) this.sliceSoon(SLICE_GAP_MS)
  }

  private pauseBuilding() {
    if (this.building !== null) (this.host.idle ? this.host.cancelIdle?.(this.building) : this.host.cancel(this.building))
    this.building = null
  }

  private resumeBuilding() {
    if (this.building === null && this.queue.length > 0) this.sliceSoon(0)
  }
}

export class LiveMark {
  readonly clock: Clock
  readonly engine: Engine
  look: Look
  def: unknown
  size: number
  visible: boolean
  dirty = true
  // undefined: not built yet (the flat art shows); null: nothing to turn.
  rig: Rig | null | undefined = undefined
  private tickedAt = 0
  private readonly turns: boolean
  private readonly paint: (picture: Picture | null) => void
  private scratch: Record<string, unknown> = {}

  constructor(clock: Clock, { look, def, size, seed, live = false, state = 'idle', turns = true, visible = true, paint }: MarkOptions) {
    this.clock = clock
    this.look = look
    this.def = def
    this.size = size
    this.visible = visible
    this.turns = turns
    this.paint = paint
    // Listening first: the app's rest is counted afresh when the first mark comes up.
    clock.add(this)
    // The engine starts from the flat art's pose and goes into the state from there, so
    // a state's opening move (a done hop, a call for attention) plays as it appears.
    this.engine = new Engine({ seed, size, live, state: 'idle', ...clock.settings })
    if (clock.isResting) this.engine.rest(true)
    if (state !== 'idle') this.engine.setState(state)
    // A photo has nothing to build: it moves as a whole from the start.
    if (!turns) this.attachRig()
    clock.kick()
  }

  attachRig() {
    if (this.rig !== undefined) return
    this.rig = this.turns ? rigFor(this.look.shape, this.def) : null
    this.dirty = true
    this.clock.kick()
  }

  // Back to the flat art, for a new shape; the model is built again when it moves.
  private detachRig() {
    this.rig = undefined
    this.scratch = {}
    this.clock.unqueue(this)
    this.paint(null)
  }

  update({ look, def, size, live, state }: { look?: Look; def?: unknown; size?: number; live?: boolean; state?: string }) {
    if (look && (look.shape !== this.look.shape || def !== this.def)) {
      this.detachRig()
      this.look = look
      this.def = def
      if (!this.turns) this.attachRig()
    } else if (look && look.color !== this.look.color) this.look = look
    if (size !== undefined && size !== this.size) { this.size = size; this.engine.setOptions({ size }) }
    if (live !== undefined) this.engine.setOptions({ live })
    if (state !== undefined) this.engine.setState(state)
    this.dirty = true
    this.clock.kick()
  }

  // On screen or not (its screen in front, the drawer open).
  setVisible(on: boolean) {
    if (on === this.visible) return
    this.visible = on
    if (on) { this.sync(); this.clock.kick() } else this.clock.unqueue(this)
  }

  // Draw again (the theme changed the inks).
  redraw() { this.dirty = true; this.clock.kick() }

  // Called by the clock: moves on and draws. Returns seconds until it needs a frame.
  step(time: number): number {
    const elapsed = this.tickedAt ? (time - this.tickedAt) / 1000 : 1 / 60
    // Marks below hero size, and every mark while the app rests, draw at most 30 times
    // a second. The desktop holds only chips and resting marks to this; on the phone
    // each frame is a new SVG built on the JS thread and parsed again natively, and a
    // row mark costs about as much as a hero.
    if ((this.engine.lod !== 'hero' || this.engine.resting) && elapsed < 1 / 31 && !this.dirty) return 1 / 30 - elapsed
    // Still on the flat art: time runs on while nothing would move. A move waits for the
    // model; the mark's clock starts again once the model is in (attachRig kicks it).
    if (this.rig === undefined && !(this.engine.atRest && this.engine.wakeIn() > elapsed)) {
      if (!rigReady(this.look.shape, this.def)) { this.clock.buildSoon(this); this.tickedAt = 0; return Infinity }
      this.attachRig()
    }
    this.tickedAt = time
    const moving = this.engine.tick(elapsed)
    if (moving || this.dirty) this.draw()
    return moving ? 0 : this.engine.wakeIn()
  }

  // The clock skipped this mark (in the background, or off screen); start its time again.
  sync() { this.tickedAt = 0; this.dirty = true }

  private draw() {
    this.dirty = false
    if (this.rig === undefined) return
    if (this.rig === null) { this.paint({ pose: flatPose(this.engine.frame) }); return }
    this.paint({ shapes: shapesOf(this.rig, this.engine.frame, this.scratch) })
  }

  // Actions, each answered with a frame.
  act(fn: (engine: Engine) => void) { fn(this.engine); this.dirty = true; this.clock.kick() }

  destroy() {
    this.clock.remove(this)
  }
}
