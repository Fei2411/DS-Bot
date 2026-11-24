import { blinkClip, CHANNELS, CLIPS, sampleTrack } from './clips.js'
import { blendable, FACES, mixEye } from './face.js'
import { STATES, stateName } from './states.js'

// One character's motion: a state, the clips it plays, the springs that carry the
// body between poses, and the actions the pointer and the app call. `tick(dt)` moves
// it on and fills `frame`; a renderer draws the frame. Nothing here touches the DOM,
// so the desktop, the web client, and the phone app share it.
//
// Motion levels (`tier`): quiet plays only the states' own motion; normal adds petting,
// pokes, and following the pointer; lively adds life at rest (blinks, glances,
// fidgets, dozing off) and repeats the call for attention. A resting mark below lively
// holds still, so a quiet window stays quiet. `effects` (the interface motion setting): `reduced`
// keeps one-shot moves and expressions but no loops; `off` holds still and changes
// expressions in place.

// Spring per channel: [ω (rad/s), damping ratio]. Squash is loose so it jiggles; eyes
// are quick so a glance snaps; the head is slower than the eyes it follows.
const SPRINGS = {
  x: [13, 0.7], y: [13, 0.7], yaw: [9, 0.78], pitch: [11, 0.75], roll: [11, 0.7],
  sq: [16, 0.42], scale: [14, 0.6], gx: [30, 0.9], gy: [30, 0.9], lid: [22, 1], pupil: [18, 0.55],
}
const POSITION = new Set(['x', 'y'])
const ROTATION = new Set(['yaw', 'pitch', 'roll'])

// Seeded random numbers (mulberry32), so a Bot's moves differ from its neighbor's.
export function random(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const lodOf = size => (size >= 48 ? 'hero' : size >= 28 ? 'row' : 'chip')

const FACE_BLEND = 0.22
// A done sparkle's length, and how long a state's accent keeps moving with no input.
const SPARKLE = 1.1
const ACCENT_RUN = 600
// A dozing mark's z drifts a few times, then holds still mid-air.
const Z_RUN = 8
const SWAP_CLOSE = 0.075
const POKE_WINDOW = 1.6

export class Avatar {
  constructor({ seed = 1, size = 36, live = false, tier = 'normal', effects = 'full', state = 'idle' } = {}) {
    this.rng = random(seed)
    this.time = 0
    this.size = size
    this.lod = lodOf(size)
    this.live = live
    this.tier = tier
    this.effects = effects
    this.springs = Object.fromEntries(CHANNELS.map(name => [name, { x: 0, v: 0, target: 0 }]))
    this.springs.scale.x = 0
    this.clips = []
    this.frame = { face: FACES.neutral, closed: [0, 0], accent: null }
    for (const name of CHANNELS) this.frame[name] = 0
    this.face = { from: FACES.neutral, to: FACES.neutral, mix: 1, name: 'neutral', swap: null }
    this.override = { face: null, faceUntil: 0, pose: null }
    this.gazeTarget = null
    this.petting = null
    this.pokes = { count: 0, last: -Infinity }
    this.saccade = { gx: 0, gy: 0, until: 0, next: 0 }
    this.dozing = false
    this.resting = false
    this.state = null
    this.setState(state, { instant: true })
  }

  get still() { return this.effects === 'off' }
  get calm() { return this.effects !== 'full' }
  // Whether the mark answers the pointer (petting, following it).
  get follows() { return !this.calm && this.tier !== 'quiet' }

  setOptions({ size, live, tier, effects }) {
    if (size !== undefined) { this.size = size; this.lod = lodOf(size) }
    if (live !== undefined) this.live = live
    if (tier !== undefined) this.tier = tier
    if (effects !== undefined) this.effects = effects
    if (this.still) this.clips = []
    if (!this.follows) { this.gazeTarget = null; this.petting = null }
    if (!Number.isFinite(this.nextLoop)) this.nextLoop = this.time + 0.3
    this.retarget()
  }

  // ---- State.
  setState(name, { instant = false } = {}) {
    const next = stateName(name)
    if (next === this.state && !instant) return
    const was = this.state
    this.state = next
    this.stateSince = this.time
    const def = STATES[next]
    // Clips of the last state fade out unless they must finish (a spin).
    for (const play of this.clips) if (!play.commit && !play.blink) play.fade = -1
    if (was === 'sleeping' && next !== 'sleeping' && !this.still) this.play('wake')
    if (!this.still && !instant) {
      const enter = this.lod === 'chip' && def.compactEnter ? def.compactEnter : def.enter
      if (enter) this.play(this.draw(enter))
    }
    this.nextLoop = this.time + (def.enter ? 0.6 : 0.15 + this.rng() * 0.4)
    this.nextBlink = this.time + 0.6 + this.rng() * 1.6
    this.retarget()
    if (instant) this.snap()
  }

  // Dozing: a resting mark nods off after a long while without input, and wakes on input.
  doze(on) {
    if (on === this.dozing) return
    this.dozing = on
    if (on && this.state === 'idle') this.setState('sleeping')
    else if (!on && this.state === 'sleeping') this.setState('idle')
  }

  // ---- Actions.
  play(name, options = {}) {
    const make = CLIPS[name]
    if (!make || this.still) return null
    const clip = make(this.rng)
    const play = { name, clip, t: 0, weight: 1, fade: 0, commit: !!clip.commit, blink: false, ...options }
    this.clips.push(play)
    if (clip.accent && this.lod !== 'chip') this.frame.accent = { kind: clip.accent, t: 0 }
    return play
  }

  blink(double = this.rng() < 0.18) {
    if (this.still) return
    const shape = this.shownFace()
    if (shape.some(eye => eye.kind !== 'capsule')) return
    this.clips.push({ name: 'blink', clip: blinkClip(double), t: 0, weight: 1, fade: 0, commit: true, blink: true })
  }

  // Holds an expression for `hold` seconds (Infinity until cleared with null).
  setFace(name, hold = 1.6) {
    this.override.face = name && FACES[name] ? name : null
    this.override.faceUntil = this.time + hold
  }

  // Looks somewhere for a while: eyes go first, the head follows.
  look(gx, gy, hold = 1.2) {
    if (this.calm) return
    this.saccade = { gx: clamp(gx, -1, 1), gy: clamp(gy, -1, 1), until: this.time + hold, next: this.time + hold + 2 }
    this.retarget()
  }

  // Follows a point: {x, y} from the mark's middle in mark radii, or null to stop.
  gaze(point) {
    this.gazeTarget = point && this.follows ? point : null
    this.retarget()
  }

  // Petting: the pointer rests on the mark. `side` is where the pointer sits (-1 left).
  pet(on, side = 1) {
    const allowed = on && this.follows
    if (!!this.petting === allowed) return
    this.petting = allowed ? { since: this.time, side: side < 0 ? -1 : 1 } : null
    if (!allowed) {
      for (const play of this.clips) if (play.name === 'nuzzle') play.fade = -1
      this.blink(false)
    }
    this.nextLoop = this.time + 0.25
    this.retarget()
  }

  // A click: each quick poke goes one step further, from a bounce to a dizzy spell.
  poke() {
    if (this.still || this.tier === 'quiet') return
    if (this.clips.some(play => play.commit && !play.blink && play.name.startsWith('poke'))) return
    const quick = this.time - this.pokes.last < POKE_WINDOW
    this.pokes.count = quick ? this.pokes.count + 1 : 1
    this.pokes.last = this.time
    if (this.calm) { this.play('pokeBounce'); return }
    const step = ['pokeBounce', 'pokeSpin', 'pokeSpin2'][this.pokes.count - 1]
    if (step) this.play(step)
    else { this.play('dizzy'); this.pokes.count = 0 }
  }

  // ---- Running.
  // Moves time on by dt seconds. Returns whether anything moved, so a quiet mark can
  // stop asking for frames until `wakeIn()`.
  tick(dt) {
    dt = Math.max(dt, 0)
    // A long gap (the mark slept between events) passes at once when nothing was
    // moving; a moving mark never jumps more than a tenth of a second.
    if (dt > 0.1) { if (this.settled) this.time += dt - 0.1; dt = 0.1 }
    this.time += dt
    const def = STATES[this.state]
    if (this.override.face && this.time >= this.override.faceUntil) this.override.face = null
    if (def.next && this.time - this.stateSince >= def.hold && !this.clips.some(play => play.commit && !play.blink)) this.setState(def.next)
    this.schedule()

    // Springs toward the pose.
    let moving = false
    const settle = (STATES[this.state].settle ?? 1)
    for (const name of CHANNELS) {
      const spring = this.springs[name]
      if (this.still) { spring.x = spring.target; spring.v = 0; continue }
      const [w0, zeta] = SPRINGS[name]
      const w = w0 * settle
      let rest = dt
      while (rest > 0) {
        const h = Math.min(rest, 1 / 240)
        const a = w * w * (spring.target - spring.x) - 2 * zeta * w * spring.v
        spring.v += a * h
        spring.x += spring.v * h
        rest -= h
      }
      if (Math.abs(spring.target - spring.x) > 1e-3 || Math.abs(spring.v) > 1e-3) moving = true
      else { spring.x = spring.target; spring.v = 0 }
    }

    // Clips on top.
    const out = {}
    for (const name of CHANNELS) out[name] = this.springs[name].x
    const amp = this.lod === 'chip' ? { pos: 0.7, rot: 0.8 } : { pos: 1, rot: 1 }
    let clipFace = null
    let blinks = 0
    for (const play of this.clips) {
      play.t += dt
      if (play.fade < 0) play.weight = Math.max(0, play.weight - dt / 0.25)
      const { clip } = play
      const t = Math.min(play.t, clip.dur)
      for (const [name, keys] of Object.entries(clip.tracks)) {
        let value = sampleTrack(keys, t) * play.weight
        if (POSITION.has(name)) value *= amp.pos
        else if (ROTATION.has(name) && name !== 'yaw') value *= amp.rot
        out[name] += value
      }
      if (clip.face) for (const [at, face] of clip.face) if (t >= at) clipFace = face === null ? undefined : face
      if (clip.blink) for (const at of clip.blink) if (!play.blinked?.includes(at) && t >= at) { (play.blinked ??= []).push(at); blinks += 1 }
      moving = true
    }
    this.clips = this.clips.filter(play => play.t < play.clip.dur && play.weight > 0)
    if (blinks > 0) this.blink(false)

    // Expression: a clip's beats over a held face over the state's.
    this.updateFace(clipFace ?? this.override.face ?? (this.petting ? (this.time - this.petting.since > 0.35 ? 'happy' : 'content') : null) ?? STATES[this.state].face, dt)
    if (this.face.mix < 1 || this.face.swap) moving = true
    let swapLid = 0
    if (this.face.swap) {
      const s = this.face.swap
      s.t += dt
      swapLid = s.t < SWAP_CLOSE ? s.t / SWAP_CLOSE : Math.max(0, 1 - (s.t - SWAP_CLOSE) / 0.16)
      if (!s.done && s.t >= SWAP_CLOSE) { this.face.from = FACES[s.name]; this.face.to = FACES[s.name]; this.face.mix = 1; s.done = true }
      if (s.t >= SWAP_CLOSE + 0.16) this.face.swap = null
    }

    const closed = clamp(out.lid + swapLid, 0, 1)
    Object.assign(this.frame, out, {
      face: this.shownFace(),
      closed: [closed, closed],
      pupil: out.pupil,
    })
    // Accents: a done sparkle plays once; a state's accent (thinking dots, dozing z)
    // runs while someone is around and holds still once the window rests.
    const held = STATES[this.state].accent
    let accent = this.frame.accent
    if (accent && accent.kind !== 'sparkle' && accent.kind !== held) accent = this.frame.accent = null
    if (!accent && held && this.lod === 'hero' && !this.calm) accent = this.frame.accent = { kind: held, t: 0 }
    if (accent) {
      if (accent.kind === 'sparkle') {
        accent.t += dt
        if (accent.t > SPARKLE) this.frame.accent = null
        moving = true
      } else if ((!this.resting || (accent.kind === 'z' && accent.t < Z_RUN)) && accent.t < ACCENT_RUN) {
        accent.t += dt
        moving = true
      }
    }
    this.settled = !moving
    return moving
  }

  // Seconds until the next thing this mark will do on its own.
  wakeIn() {
    if (this.clips.length > 0 || this.face.swap || this.face.mix < 1) return 0
    if (this.still || (this.resting && !this.petting)) return Infinity
    // Only what would really happen counts, or a still mark would wake for nothing.
    const times = []
    if (this.loopOf(STATES[this.state])) times.push(this.nextLoop)
    if (this.blinks()) times.push(this.nextBlink)
    if (this.glances()) times.push(this.saccade.until > this.time ? this.saccade.until : this.saccade.next)
    if (this.override.face) times.push(this.override.faceUntil)
    const def = STATES[this.state]
    if (def.next) times.push(this.stateSince + def.hold)
    return Math.max(0, Math.min(...times.filter(Number.isFinite)) - this.time)
  }

  // Resting: nobody has touched the window for a while. Moves under way finish, but
  // nothing new starts until it is lifted.
  rest(on) {
    this.resting = on
    if (!on) { this.nextLoop = Math.min(this.nextLoop, this.time + 0.4 + this.rng() * 1.2); this.nextBlink = Math.min(this.nextBlink, this.time + 0.3 + this.rng()) }
  }

  // ---- Inside.
  schedule() {
    if (this.still) return
    const def = STATES[this.state]
    if (this.resting && !this.petting) return
    if (this.blinks() && this.time >= this.nextBlink) {
      this.blink()
      this.nextBlink = this.time + def.blink[0] + this.rng() * (def.blink[1] - def.blink[0])
    }
    if (this.glances()) {
      const s = this.saccade
      if (s.until > 0 && this.time >= s.until) { s.until = 0; s.gx = 0; s.gy = 0; this.retarget() }
      if (s.until === 0 && this.time >= s.next) {
        s.gx = (this.rng() * 2 - 1) * 0.3
        s.gy = (this.rng() * 2 - 1) * 0.18
        s.until = this.time + 0.5 + this.rng() * 1.3
        s.next = s.until + 2.5 + this.rng() * 4
        this.retarget()
      }
    }
    // The state's clips.
    if (this.time < this.nextLoop) return
    if (this.clips.some(play => !play.blink && play.weight >= 1)) return
    const loop = this.loopOf(def)
    if (!loop) { this.nextLoop = this.petting || def.next ? this.time + 0.5 : Infinity; return }
    this.play(this.draw(loop.bag))
    const played = this.clips[this.clips.length - 1]
    const dur = played?.clip.dur ?? 0
    this.nextLoop = this.time + dur + loop.gap[0] + this.rng() * (loop.gap[1] - loop.gap[0])
  }

  // Blinks are part of every state's motion; at rest only a lively mark blinks.
  blinks() {
    const def = STATES[this.state]
    const ambient = this.state === 'idle' || this.state === 'sleeping'
    return !!def.blink && (!ambient || !!this.petting || (this.live && this.tier === 'lively'))
  }

  // Small glances while resting, on large lively marks.
  glances() {
    return this.state === 'idle' && this.live && this.tier === 'lively' && !this.calm && this.lod !== 'chip' && !this.gazeTarget && !this.petting
  }

  loopOf(def) {
    if (this.calm) return null
    if (this.petting) return { bag: { nuzzle: 1 }, gap: [0.05, 0.3] }
    if (this.lod === 'chip' && def.compact) return def.compact
    if (def.loop) return def.loop
    if (def.lively && this.tier === 'lively') return def.lively
    if (def.idle && this.live && this.tier === 'lively' && this.lod !== 'chip') return def.idle
    return null
  }

  // A weighted draw that avoids playing the same clip twice in a row.
  draw(bag) {
    const entries = Object.entries(bag).filter(([name]) => CLIPS[name])
    const pool = entries.length > 1 ? entries.filter(([name]) => name !== this.lastDrawn) : entries
    const total = pool.reduce((sum, [, weight]) => sum + weight, 0)
    let pick = this.rng() * total
    for (const [name, weight] of pool) {
      pick -= weight
      if (pick <= 0) { this.lastDrawn = name; return name }
    }
    this.lastDrawn = pool[pool.length - 1]?.[0]
    return this.lastDrawn
  }

  retarget() {
    const pose = STATES[this.state].pose
    const target = Object.fromEntries(CHANNELS.map(name => [name, pose[name] ?? 0]))
    const g = this.gazeTarget
    if (g) {
      const d = Math.hypot(g.x, g.y)
      // Near the mark it turns toward you; further off it looks where the pointer is.
      const near = clamp(1 - d / 3, 0, 1)
      target.gx = clamp(g.x / 3, -1, 1) * 0.9 * (1 - near * 0.6)
      target.gy = clamp(g.y / 3, -1, 1) * 0.8 * (1 - near * 0.6)
      target.yaw += clamp(g.x / 4, -1, 1) * 16 - near * 26
      target.pitch += clamp(g.y / 4, -1, 1) * 10 - near * 4
    } else if (this.saccade.until > this.time) {
      target.gx += this.saccade.gx
      target.gy += this.saccade.gy
    }
    if (this.petting) {
      target.yaw = Math.min(target.yaw, 0) - 24
      target.pitch -= 4
      target.roll += this.petting.side * 5
      target.gx = 0
      target.gy = 0
    }
    if (this.state === 'sleeping' || this.state === 'done') { target.gx = pose.gx ?? 0; target.gy = pose.gy ?? 0 }
    for (const name of CHANNELS) this.springs[name].target = target[name]
  }

  snap() {
    for (const name of CHANNELS) { const s = this.springs[name]; s.x = s.target; s.v = 0 }
    const face = FACES[STATES[this.state].face]
    this.face = { from: face, to: face, mix: 1, name: STATES[this.state].face, swap: null }
  }

  shownFace() {
    const { from, to, mix } = this.face
    return mix >= 1 ? to : [mixEye(from[0], to[0], ease(mix)), mixEye(from[1], to[1], ease(mix))]
  }

  updateFace(name, dt) {
    const face = this.face
    if (name !== face.name) {
      const target = FACES[name] ?? FACES.neutral
      const shown = this.shownFace()
      face.name = name
      if (this.still) { face.from = target; face.to = target; face.mix = 1; face.swap = null }
      else if (blendable(shown, target)) { face.from = shown; face.to = target; face.mix = 0; face.swap = null }
      else { face.swap = { name, t: 0, done: false }; face.from = shown; face.to = shown; face.mix = 1 }
    }
    if (face.mix < 1) face.mix = Math.min(1, face.mix + dt / FACE_BLEND)
  }
}

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value))
const ease = t => t * t * (3 - 2 * t)
