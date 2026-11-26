import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHARACTERS, PICKER_SHAPES, SHAPES } from '../src/client/characters.js'
import { flatten } from '../src/client/avatar/sdf.js'
import { rigFor } from '../src/client/avatar/rig.js'
import { drawShapes, shapesOf, pathsOf } from '../src/client/avatar/render.js'
import { silhouette } from '../src/client/avatar/silhouette.js'
import { Avatar, random } from '../src/client/avatar/engine.js'
import { CLIPS, TURN, blinkClip } from '../src/client/avatar/clips.js'
import { FACES, eyePolygons, mixEye } from '../src/client/avatar/face.js'
import { STATES } from '../src/client/avatar/states.js'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const REST = { x: 0, y: 0, yaw: 0, pitch: 0, roll: 0, sq: 0, scale: 0, gx: 0, gy: 0, lid: 0, pupil: 0, face: FACES.neutral, closed: [0, 0], accent: null }

const box = (points) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (let i = 0; i < points.length; i += 2) {
    x0 = Math.min(x0, points[i]); x1 = Math.max(x1, points[i])
    y0 = Math.min(y0, points[i + 1]); y1 = Math.max(y1, points[i + 1])
  }
  return { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 }
}
const signedArea = (points) => {
  let sum = 0
  for (let i = 0, j = points.length - 2; i < points.length; j = i, i += 2) sum += points[j] * points[i + 1] - points[i] * points[j + 1]
  return sum / 2
}
// The art fills its path even-odd: the largest loop, less the loops cut out of it.
const pathArea = (d) => {
  const areas = flatten(d).map(loop => Math.abs(signedArea(loop.flat()))).sort((a, b) => b - a)
  return areas[0] - areas.slice(1).reduce((sum, a) => sum + a, 0)
}

test('the traced art still comes from the shared models, byte for byte', () => {
  // A Windows checkout may have CRLF line ends.
  const printed = execFileSync(process.execPath, [join(PLUGIN, 'dev/characters.mjs')], { encoding: 'utf8' }).replaceAll('\r\n', '\n')
  const source = readFileSync(join(PLUGIN, 'src/client/characters.js'), 'utf8').replaceAll('\r\n', '\n')
  const block = source.slice(source.indexOf('export const CHARACTERS = {'), source.indexOf('\n}\n', source.indexOf('export const CHARACTERS = {')) + 2)
  assert.equal(printed.trim(), block.trim())
})

test('every character at rest matches its flat art, so the live layer takes over without a jump', () => {
  for (const id of [...PICKER_SHAPES, 'magnet', 'ring', 'gem']) {
    const rig = rigFor(id, SHAPES[id])
    assert.ok(rig, `${id} has a rig`)
    const shapes = shapesOf(rig, REST)
    const all = shapes.body.flatMap(loop => [...loop])
    const live = box(all)
    // Placed like the art: the longer side fills 92 of 100 units, centered.
    assert.ok(Math.abs(Math.max(live.x1 - live.x0, live.y1 - live.y0) - 92) < 1, `${id} fills 92 units`)
    assert.ok(Math.abs(live.cx - 50) < 1 && Math.abs(live.cy - 50) < 1, `${id} is centered`)
    // The same silhouette: the filled areas agree within a few percent.
    const liveArea = Math.abs(shapes.body.reduce((sum, loop) => sum + signedArea(loop), 0))
    const flatArea = Math.abs(pathArea(CHARACTERS[id].body))
    assert.ok(Math.abs(liveArea - flatArea) / flatArea < 0.04, `${id} area ${liveArea.toFixed(0)} vs ${flatArea.toFixed(0)}`)
    // The eyes sit where the art cuts them, as tall as the art's.
    assert.equal(shapes.eyes.length, 2, `${id} shows both eyes`)
    shapes.eyes.forEach((eye, index) => {
      const [cx, cy, , h] = CHARACTERS[id].eyes[index]
      const at = box(eye)
      assert.ok(Math.hypot(at.cx - cx, at.cy - cy) < 1.5, `${id} eye ${index} at ${at.cx.toFixed(1)},${at.cy.toFixed(1)} vs ${cx},${cy}`)
      assert.ok(Math.abs((at.y1 - at.y0) - h) < h * 0.15, `${id} eye ${index} height`)
    })
  }
})

test('a turned character keeps a closed outline, hides an eye that goes round the back, and keeps holes open', () => {
  const rig = rigFor('bear', SHAPES.bear)
  const back = shapesOf(rig, { ...REST, yaw: 180 })
  assert.equal(back.eyes.length, 0)
  assert.ok(back.body.length >= 1)
  const front = shapesOf(rig, { ...REST, yaw: -34 })
  assert.equal(front.eyes.length, 2)
  // The ring's hole is a loop of its own, wound against the outside.
  const ring = rigFor('ring', SHAPES.ring)
  const loops = silhouette(ring.mesh, [0, 0, 1])
  assert.ok(loops.length >= 2)
  const areas = shapesOf(ring, { ...REST, yaw: -34, pitch: -16, roll: -10 }).body.map(signedArea)
  assert.ok(areas.some(a => a > 0) && areas.some(a => a < 0))
  // Path data for renderers without a canvas.
  const paths = pathsOf(front)
  assert.match(paths.body, /^M[\d.-]+ [\d.-]+Q/)
  const eyes = paths.eyes.split('Z').filter(Boolean)
  assert.equal(eyes.length, 2)
  front.eyes.forEach((eye, index) => {
    assert.equal(eyes[index], `M${(Math.round(eye[0] * 100) / 100)} ${(Math.round(eye[1] * 100) / 100)}${eyes[index].slice(eyes[index].indexOf('L'))}`, `eye ${index} starts at its own first point`)
    assert.equal(eyes[index].match(/L/g)?.length, eye.length / 2 - 1, `eye ${index} draws every point`)
  })
})

test('every clip starts and ends at rest, so it can begin or stop at any moment', () => {
  for (const [name, make] of Object.entries(CLIPS)) {
    for (const seed of [1, 2, 3, 4]) {
      let n = seed
      const rng = () => ((n = (n * 16807) % 2147483647) / 2147483647)
      const clip = make(rng)
      assert.ok(clip.dur > 0, name)
      for (const [channel, keys] of Object.entries(clip.tracks)) {
        const first = keys[0]
        const last = keys[keys.length - 1]
        // `appear` grows in from small and low: it only plays as a mark arrives.
        if (name !== 'appear') assert.equal(first[1] + 0, 0, `${name}.${channel} starts at 0`)
        const end = channel === 'yaw' ? last[1] % 360 : last[1]
        assert.equal(end + 0, 0, `${name}.${channel} ends at rest`)
        assert.ok(last[0] <= clip.dur + 1e-9, `${name}.${channel} fits the clip`)
        for (let i = 1; i < keys.length; i += 1) assert.ok(keys[i][0] >= keys[i - 1][0], `${name}.${channel} keys in order`)
      }
    }
  }
  for (const double of [false, true]) for (const keys of Object.values(blinkClip(double).tracks)) assert.equal(keys[keys.length - 1][1], 0)
})

test('every expression draws two eyes, and a closed eye keeps a thin slit', () => {
  for (const [name, face] of Object.entries(FACES)) {
    face.forEach((shape, index) => {
      const polys = eyePolygons(shape, 9, 22, index === 0 ? -1 : 1)
      assert.ok(polys.length >= 1 && polys.every(p => p.length >= 6 && p.every(Number.isFinite)), name)
    })
  }
  const closed = box(eyePolygons(FACES.neutral[0], 9, 22, -1, 1)[0])
  assert.ok(Math.abs((closed.y1 - closed.y0) - 0.2 * 9) < 0.01)
})

const run = (avatar, seconds, each) => { for (let t = 0; t < seconds; t += 1 / 60) { avatar.tick(1 / 60); each?.(avatar) } }
const blinks = avatar => avatar.clips.filter(play => play.blink).length

test('a mark at rest is still below the lively level, and alive at it', () => {
  for (const tier of ['quiet', 'normal']) {
    const avatar = new Avatar({ seed: 3, size: 44, live: true, tier })
    let moved = 0
    run(avatar, 30, (a) => { moved += blinks(a) + a.clips.length })
    assert.equal(moved, 0, `${tier} rests without moving`)
    assert.equal(avatar.wakeIn(), Infinity)
  }
  const lively = new Avatar({ seed: 3, size: 44, live: true, tier: 'lively' })
  let blinked = 0
  let fidgets = new Set()
  run(lively, 40, (a) => { blinked += blinks(a) ? 1 : 0; for (const play of a.clips) if (!play.blink) fidgets.add(play.name) })
  assert.ok(blinked > 0, 'lively blinks')
  assert.ok(fidgets.size >= 2, `lively fidgets vary: ${[...fidgets]}`)
  // A transcript mark (not live) does not fidget even when lively.
  const still = new Avatar({ seed: 3, size: 22, live: false, tier: 'lively' })
  run(still, 20)
  assert.equal(still.clips.length, 0)
})

test('a state moves at every motion level, blinks included, and two Bots do not move in step', () => {
  for (const tier of ['quiet', 'normal', 'lively']) {
    const avatar = new Avatar({ seed: 5, size: 36, tier, state: 'idle' })
    avatar.setState('working')
    const seen = new Set()
    let blinked = 0
    run(avatar, 12, (a) => {
      for (const play of a.clips) {
        if (play.blink) blinked += 1
        else seen.add(play.name)
      }
    })
    assert.ok(seen.size >= 2, `${tier} working varies: ${[...seen]}`)
    assert.ok(blinked > 0, `${tier} blinks while working`)
  }
  const a = new Avatar({ seed: 11, size: 36 })
  const b = new Avatar({ seed: 12, size: 36 })
  a.setState('working')
  b.setState('working')
  const pitches = [[], []]
  run(a, 3, x => pitches[0].push(x.frame.pitch))
  run(b, 3, x => pitches[1].push(x.frame.pitch))
  assert.notDeepEqual(pitches[0], pitches[1])
  // The same seed moves the same way.
  const c = new Avatar({ seed: 11, size: 36 })
  c.setState('working')
  const again = []
  run(c, 3, x => again.push(x.frame.pitch))
  assert.deepEqual(again, pitches[0])
})

test('each state shows its own face and pose', () => {
  const avatar = new Avatar({ seed: 2, size: 60, effects: 'off' })
  for (const [name, def] of Object.entries(STATES)) {
    avatar.setState(name)
    avatar.tick(1 / 60)
    assert.deepEqual(avatar.frame.face, FACES[def.face], name)
    for (const [channel, value] of Object.entries(def.pose)) assert.equal(avatar.frame[channel], value, `${name}.${channel}`)
  }
  // With interface motion off nothing plays: the pose and the face change in place.
  assert.equal(avatar.clips.length, 0)
  avatar.poke()
  avatar.blink()
  assert.equal(avatar.clips.length, 0)
  assert.equal(avatar.tick(1 / 60), false)
})

test('done celebrates once and goes back to rest; a question makes the Bot sit up and look at you', () => {
  const avatar = new Avatar({ seed: 4, size: 60 })
  avatar.setState('done')
  assert.ok(avatar.clips.some(play => ['celebrate', 'nodHappy', 'hopHappy'].includes(play.name)))
  run(avatar, 3)
  assert.equal(avatar.state, 'idle')
  avatar.setState('alert')
  assert.ok(avatar.clips.some(play => play.name === 'attention'))
  run(avatar, 2)
  assert.ok(avatar.frame.scale > 0.02 && avatar.frame.y < 0, 'sits up')
  assert.ok(Math.abs(avatar.frame.yaw) <= TURN && Math.abs(avatar.frame.gx) < 0.1, 'eyes on you, body not turned')
  assert.equal(avatar.face.name, 'wide')
})

test('quick pokes go from a bounce to spins to a dizzy spell; quiet ignores them', () => {
  const avatar = new Avatar({ seed: 9, size: 60 })
  const played = []
  for (let i = 0; i < 4; i += 1) {
    avatar.poke()
    played.push(avatar.clips.filter(play => !play.blink).at(-1)?.name)
    run(avatar, 0.3)
    // A spin finishes before the next poke counts.
    while (avatar.clips.some(play => play.commit && !play.blink)) avatar.tick(1 / 60)
  }
  assert.deepEqual(played, ['pokeBounce', 'pokeSpin', 'pokeSpin2', 'dizzy'])
  const quiet = new Avatar({ seed: 9, size: 60, tier: 'quiet' })
  quiet.poke()
  assert.equal(quiet.clips.length, 0)
})

test('a resting window keeps showing what a Bot does, more sparsely, and nothing else; a lively mark dozes off and wakes', () => {
  // Someone glancing at the screen to see how the work goes is not touching anything:
  // a state's own moves go on, a few seconds apart.
  const moves = (avatar, seconds) => {
    let started = 0
    run(avatar, seconds, (a) => { started += a.clips.filter(play => !play.blink && play.t === 1 / 60).length })
    return started
  }
  const awake = new Avatar({ seed: 6, size: 44, live: true, tier: 'lively' })
  awake.setState('working')
  run(awake, 2)
  const resting = new Avatar({ seed: 6, size: 44, live: true, tier: 'lively' })
  resting.setState('working')
  run(resting, 2)
  resting.rest(true)
  run(resting, 2)
  const busy = moves(awake, 30)
  const glanced = moves(resting, 30)
  assert.ok(glanced >= 3, `still working while resting (${glanced} moves in 30 s)`)
  assert.ok(glanced * 3 < busy, `but sparser (${glanced} against ${busy})`)
  assert.ok(resting.wakeIn() <= 8, 'its clock wakes for the next move')
  // Idle fidgets, glances and blinks wait for input.
  const idle = new Avatar({ seed: 6, size: 44, live: true, tier: 'lively' })
  idle.rest(true)
  run(idle, 0.5)
  const before = idle.clips.length
  run(idle, 30, (a) => { assert.equal(a.clips.filter(play => play.t > 0 && play.t <= 1 / 60).length, 0, 'nothing new while idle and resting') })
  assert.equal(before, 0)
  assert.equal(idle.wakeIn(), Infinity)
  // A pointer left on a working mark is nobody petting it: the work still shows.
  const hovered = new Avatar({ seed: 6, size: 44, live: true, tier: 'normal' })
  hovered.setState('working')
  hovered.pet(true, 1)
  run(hovered, 2)
  hovered.rest(true)
  run(hovered, 2)
  const underPointer = moves(hovered, 30)
  assert.ok(underPointer >= 3, `working under a resting pointer (${underPointer} moves in 30 s)`)
  assert.ok(!hovered.clips.some(play => play.name === 'nuzzle'), 'and no petting')
  // Nor its smile or lean: a failed Bot under a resting pointer looks worried, not pleased.
  const sorry = new Avatar({ seed: 6, size: 44, live: true, tier: 'normal' })
  sorry.setState('failed')
  sorry.pet(true, 1)
  run(sorry, 2)
  assert.equal(sorry.face.name, 'happy', 'petted while someone is around')
  sorry.rest(true)
  run(sorry, 2)
  assert.equal(sorry.face.name, 'worried')
  assert.ok(Math.abs(sorry.springs.x.target - (STATES.failed.pose.x ?? 0)) < 1e-9, 'and no lean into the hand')
  sorry.rest(false)
  run(sorry, 1)
  assert.equal(sorry.face.name, 'happy', 'the hand counts again on input')
  resting.rest(false)
  run(resting, 2)
  assert.ok(resting.clips.length > 0 || resting.wakeIn() < 1)
  const avatar = resting
  avatar.setState('idle')
  avatar.doze(true)
  assert.equal(avatar.state, 'sleeping')
  run(avatar, 3)
  assert.equal(avatar.face.name, 'asleep')
  avatar.doze(false)
  assert.equal(avatar.state, 'idle')
  assert.ok(avatar.clips.some(play => play.name === 'wake'))
})

test('the pointer: eyes follow it and the body leans, petting leans into the hand with a smile', () => {
  const avatar = new Avatar({ seed: 1, size: 64, live: true })
  avatar.gaze({ x: -6, y: 0 })
  run(avatar, 1)
  assert.ok(avatar.frame.gx < -0.9, 'the eyes look left')
  assert.ok(avatar.frame.roll > 2 && avatar.frame.x < -1, 'the body leans and shifts left')
  assert.ok(Math.abs(avatar.frame.yaw) <= TURN, 'without turning')
  avatar.gaze(null)
  avatar.pet(true, 1)
  run(avatar, 1)
  assert.equal(avatar.face.name, 'happy')
  assert.ok(avatar.frame.roll < -3 && avatar.frame.sq > 0.02, 'leans right into the hand and sinks under it')
  assert.ok(Math.abs(avatar.frame.yaw) <= TURN)
  avatar.pet(false)
  run(avatar, 1)
  assert.equal(avatar.face.name, 'neutral')
  // Reduced interface motion keeps the Bot from following the pointer.
  const calm = new Avatar({ seed: 1, size: 64, live: true, effects: 'reduced' })
  calm.gaze({ x: -6, y: 0 })
  assert.equal(calm.gazeTarget, null)
})

test('done hands back to idle with motion off or the window resting, and reduced motion repeats nothing', () => {
  for (const options of [{ effects: 'off' }, { resting: true }]) {
    const avatar = new Avatar({ seed: 2, size: 44, effects: options.effects ?? 'full' })
    if (options.resting) avatar.rest(true)
    avatar.setState('done')
    // As the clock runs it: frames while it moves, else a wake-up when it asks for one.
    for (let step = 0; step < 2000 && avatar.state === 'done'; step += 1) {
      const wait = avatar.wakeIn()
      assert.ok(Number.isFinite(wait), `${JSON.stringify(options)}: the clock is woken for the hand-off`)
      avatar.tick(wait === 0 ? 1 / 60 : wait + 0.01)
    }
    assert.equal(avatar.state, 'idle')
  }
  const calm = new Avatar({ seed: 2, size: 64, effects: 'reduced', state: 'working' })
  let repeated = 0
  run(calm, 20, (a) => { repeated += a.clips.length + (a.frame.accent ? 1 : 0) })
  assert.equal(repeated, 0, 'no loop, blink or flourish under reduced motion')
  assert.equal(calm.wakeIn(), Infinity)
})

// The characters are flat art seen from one side: a turn of more than a few degrees
// shows the flat side, with both eyes slid to one edge.
test('only a spin turns the body: poses, clips, following and petting stay within TURN', () => {
  for (const [name, def] of Object.entries(STATES)) assert.ok(Math.abs(def.pose.yaw ?? 0) <= TURN, `${name} pose`)
  for (const [name, make] of Object.entries(CLIPS)) {
    for (let seed = 1; seed <= 6; seed += 1) {
      const keys = make(random(seed)).tracks.yaw ?? [[0, 0]]
      const most = Math.max(...keys.map(([, value]) => Math.abs(value)))
      if (most >= 360) continue
      assert.ok(most <= TURN, `${name} turns ${most}°`)
    }
  }
  const avatar = new Avatar({ seed: 2, size: 64, live: true })
  for (const point of [{ x: -6, y: 0 }, { x: 0.2, y: 0.1 }, { x: 3, y: -4 }, { x: 0, y: 6 }]) {
    avatar.gaze(point)
    run(avatar, 1)
    assert.ok(Math.abs(avatar.frame.yaw) <= TURN, `following ${JSON.stringify(point)}`)
  }
  avatar.gaze(null)
  for (const side of [-1, 1]) {
    avatar.pet(true, side)
    run(avatar, 1)
    assert.ok(Math.abs(avatar.frame.yaw) <= TURN, 'petting')
    avatar.pet(false)
  }
})

// How tight an outline's tightest bend is, in eye widths: the outline is walked in even
// steps, and at each step a circle passes through the points a tenth of the width before
// and after. A square corner gives under 0.1.
const tightest = (points, W) => {
  const step = 0.02 * W
  const pts = []
  for (let i = 0; i < points.length; i += 2) {
    const a = [points[i], points[i + 1]]
    const b = [points[(i + 2) % points.length], points[(i + 3) % points.length]]
    const length = Math.hypot(b[0] - a[0], b[1] - a[1])
    for (let s = 0; s < length; s += step) pts.push([a[0] + ((b[0] - a[0]) * s) / length, a[1] + ((b[1] - a[1]) * s) / length])
  }
  let worst = Infinity
  pts.forEach((b, i) => {
    const a = pts.at(i - 5), c = pts[(i + 5) % pts.length]
    const twice = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]))
    if (twice < 1e-9) return
    const sides = Math.hypot(b[0] - a[0], b[1] - a[1]) * Math.hypot(c[0] - b[0], c[1] - b[1]) * Math.hypot(a[0] - c[0], a[1] - c[1])
    worst = Math.min(worst, sides / (2 * twice) / W)
  })
  return worst
}

test('a lid meets the eye in a round corner, so no expression has square eyes', () => {
  for (const [name, face] of Object.entries(FACES)) {
    face.forEach((shape, index) => {
      if (shape.kind !== 'capsule') return
      for (const [W, H] of [[10, 23], [9, 22], [12, 18]]) {
        const bend = tightest(eyePolygons(shape, W, H, index ? 1 : -1)[0], W)
        assert.ok(bend > 0.13, `${name} eye ${index} at ${W}×${H} bends at ${bend.toFixed(2)} eye widths`)
      }
    })
  }
})

test('a lid that only just comes down leaves the eye as it was, so faces blend without a jump', () => {
  for (const [name, face] of Object.entries(FACES)) {
    face.forEach((shape, index) => {
      if (shape.kind !== 'capsule' || !(shape.top > 0 || shape.bottom > 0)) return
      const side = index ? 1 : -1
      for (const [W, H] of [[10, 13], [10, 23], [12, 18]]) {
        const start = Math.abs(signedArea(eyePolygons(FACES.neutral[index], W, H, side)[0]))
        let last = start
        for (let t = 0.001; t <= 1; t += t < 0.01 ? 0.003 : 0.02) {
          const area = Math.abs(signedArea(eyePolygons(mixEye(FACES.neutral[index], shape, t), W, H, side)[0]))
          assert.ok(Math.abs(area - last) < 0.03 * start, `${name} eye ${index} at ${W}×${H}: ${last.toFixed(1)} → ${area.toFixed(1)} at t = ${t.toFixed(3)}`)
          last = area
        }
      }
    })
  }
})

test('a spin throws confetti that stays on the canvas; a bounce and reduced effects throw none', () => {
  const avatar = new Avatar({ seed: 9, size: 64 })
  avatar.poke()
  assert.equal(avatar.frame.accent, null, 'a single poke only bounces')
  run(avatar, 0.3)
  avatar.poke()
  assert.equal(avatar.frame.accent?.kind, 'confetti')
  const { seed } = avatar.frame.accent.bursts[0]
  // The next poke, once the spin is over, spins twice while the first burst is still in
  // the air: that one throws more, and the first falls on.
  run(avatar, 0.95)
  avatar.poke()
  assert.equal(avatar.frame.accent.bursts.length, 2)
  assert.equal(avatar.frame.accent.bursts[0].seed, seed)
  run(avatar, 0.8)
  assert.equal(avatar.frame.accent?.bursts.length, 1, 'the first burst is over, the second still falls')
  run(avatar, 1)
  assert.equal(avatar.frame.accent, null, 'and it is over')
  // Where each piece is drawn, from start to end, in the mark's box: the canvas reaches
  // 30 units past it on each side (MARGIN in live.js).
  const at = []
  let origin = [0, 0]
  const stack = []
  const ctx = new Proxy({}, {
    get: (target, key) => {
      if (key === 'save') return () => stack.push(origin)
      if (key === 'restore') return () => { origin = stack.pop() }
      if (key === 'translate') return (x, y) => { origin = [origin[0] + x, origin[1] + y]; at.push(origin) }
      return key in target ? target[key] : () => {}
    },
    set: (target, key, value) => { target[key] = value; return true },
  })
  for (let t = 0; t < 1.7; t += 0.05) drawShapes(ctx, { body: [], paints: [], eyes: [], accent: { kind: 'confetti', t, bursts: [{ at: 0, seed }] }, offset: [0, 0] }, '#000', ['#111'])
  assert.ok(at.length > 0)
  for (const [x, y] of at) assert.ok(x > -25 && x < 125 && y > -25 && y < 125, `piece at ${x.toFixed(0)}, ${y.toFixed(0)}`)
  // It goes behind what is drawn, after the decals (which paint only on what is there)
  // and before the eyes are cut out of everything.
  const steps = []
  const order = new Proxy({}, {
    get: (target, key) => {
      if (key === 'fill' || key === 'fillRect' || key === 'stroke') return () => steps.push(`${key}:${target.globalCompositeOperation ?? 'source-over'}`)
      return key in target ? target[key] : () => {}
    },
    set: (target, key, value) => { target[key] = value; return true },
  })
  const shapes = shapesOf(rigFor('whale', SHAPES.whale), REST)
  assert.ok(shapes.paints.some(paint => paint.count > 0), 'the whale has its belly')
  drawShapes(order, { ...shapes, accent: { kind: 'confetti', t: 0.3, bursts: [{ at: 0, seed }] } }, '#000', ['#111'])
  const confetti = steps.filter(step => step.startsWith('fillRect') || step.startsWith('stroke'))
  assert.ok(confetti.length > 0 && confetti.every(step => step.endsWith('destination-over')), 'confetti goes behind')
  assert.ok(steps.lastIndexOf('fill:source-atop') < steps.indexOf(confetti[0]), 'after the decals')
  assert.ok(steps.lastIndexOf(confetti.at(-1)) < steps.indexOf('fill:destination-out'), 'before the eyes are cut out')
  const calm = new Avatar({ seed: 9, size: 64, effects: 'reduced' })
  for (let i = 0; i < 3; i += 1) { calm.poke(); run(calm, 0.8) }
  assert.equal(calm.frame.accent, null)
})

// How far a mark's outline moves on screen, in pixels at `size`: the largest travel of
// any edge of its box over `seconds`, after a second to settle into the state.
function travel(id, state, size, seconds, { resting = false, tier = 'normal', effects = 'full' } = {}) {
  const rig = rigFor(id, SHAPES[id])
  const avatar = new Avatar({ seed: 5, size, live: true, tier, effects })
  avatar.setState(state)
  if (resting) avatar.rest(true)
  run(avatar, 1)
  const edges = [[], [], [], []]
  const scratch = {}
  run(avatar, seconds, (a) => {
    const loops = shapesOf(rig, a.frame, scratch).body.map(loop => box(loop))
    const b = [Math.min(...loops.map(l => l.x0)), Math.min(...loops.map(l => l.y0)), Math.max(...loops.map(l => l.x1)), Math.max(...loops.map(l => l.y1))]
    b.forEach((v, i) => edges[i].push(v * size / 100))
  })
  return Math.max(...edges.map(list => Math.max(...list) - Math.min(...list)))
}

test('what a Bot is doing shows in its motion down to an 18px mark, also while the window rests', () => {
  // All 20 characters pass; these three move least (acorn thinking 1.18 px, puppy in the
  // background 1.19 px, bear waiting 1.27 px), so they guard the rest.
  for (const id of ['acorn', 'puppy', 'bear']) {
    for (const state of ['thinking', 'searching', 'working', 'sending', 'relaying', 'waiting', 'background', 'alert', 'failed']) {
      const awake = travel(id, state, 18, 12)
      assert.ok(awake >= 1, `${id} ${state} at 18px moves ${awake.toFixed(2)}px`)
      const resting = travel(id, state, 18, 20, { resting: true })
      assert.ok(resting >= 1, `${id} ${state} at 18px, window resting, moves ${resting.toFixed(2)}px`)
    }
    // Idle and an unread reply stay still below the lively level.
    for (const state of ['idle', 'replied']) assert.ok(travel(id, state, 18, 12) < 0.05, `${id} ${state} holds still`)
  }
})

test('a question keeps calling at every motion level until it is answered; reduced motion calls once', () => {
  const calls = (options) => {
    const avatar = new Avatar({ seed: 4, size: 36, live: true, ...options })
    avatar.setState('alert')
    let count = 0
    let entered = 0
    run(avatar, 20, (a) => {
      count += a.clips.filter(play => play.name === 'call' && play.t === 1 / 60).length
      entered += a.clips.filter(play => play.name === 'attention' && play.t === 1 / 60).length
    })
    return { count, entered }
  }
  for (const tier of ['quiet', 'normal', 'lively']) {
    const { count, entered } = calls({ tier })
    assert.ok(count >= 4, `${tier}: ${count} calls in 20 s`)
    assert.equal(entered, 1, `${tier}: sits up once`)
  }
  // Reduced motion: the one-shot call on entering, then nothing repeats.
  assert.deepEqual(calls({ effects: 'reduced' }), { count: 0, entered: 1 })
})

test('a failed turn slumps the Bot and it shakes its head, no; sending dashes one way, relaying swings both ways', () => {
  const avatar = new Avatar({ seed: 2, size: 36, live: true })
  avatar.setState('failed')
  run(avatar, 2)
  assert.equal(avatar.face.name, 'worried')
  assert.ok(STATES.failed.pose.y > 0 && STATES.failed.pose.pitch > 0, 'slumped')
  const shake = CLIPS.shake(random(1))
  const turns = shake.tracks.x.slice(1).filter(([, v], i) => Math.sign(v) !== Math.sign(shake.tracks.x[i][1]) && v !== 0).length
  assert.ok(turns >= 4, `a shake goes back and forth (${turns} turns)`)
  const reach = (made) => { const xs = made.tracks.x.map(([, v]) => v); return [Math.min(...xs), Math.max(...xs)] }
  const [dashLo, dashHi] = reach(CLIPS.dash(random(1)))
  assert.ok(dashHi > 2 * Math.abs(dashLo), 'a dash goes one way, after a small wind-up')
  const [relayLo, relayHi] = reach(CLIPS.relay(random(1)))
  assert.ok(Math.abs(relayLo + relayHi) < 0.5 && relayHi > 4, 'a relay swings as far both ways')
})

test('asleep, a lively mark peeks now and then, less often the longer it sleeps, also while the window rests', () => {
  const avatar = new Avatar({ seed: 7, size: 64, live: true, tier: 'lively' })
  avatar.rest(true)
  avatar.doze(true)
  const peeks = []
  let peeked = false
  let opened = false
  let breaths = 0
  for (let t = 0; t < 240; t += 1 / 30) {
    // Ticked the way the clock does: frames while moving, else a jump to the next move.
    const wait = avatar.wakeIn()
    avatar.tick(wait === 0 ? 1 / 30 : Math.min(wait + 0.01, 5))
    if (avatar.clips.some(play => play.name === 'sneak') && !peeked) peeks.push(avatar.time)
    peeked = avatar.clips.some(play => play.name === 'sneak')
    if (avatar.clips.some(play => play.name === 'breathe')) breaths += 1
    const shown = avatar.shownFace()
    if (shown.filter(eye => eye.kind === 'capsule').length === 1) opened = true
  }
  assert.ok(opened, 'one eye opens, the other stays shut')
  assert.ok(peeks.length >= 3, `peeks at ${peeks.map(t => t.toFixed(0))}`)
  const gaps = peeks.slice(1).map((t, i) => t - peeks[i])
  for (let i = 1; i < gaps.length; i += 1) assert.ok(gaps[i] > gaps[i - 1], `gaps grow: ${gaps.map(g => g.toFixed(0))}`)
  assert.equal(avatar.state, 'sleeping')
  assert.equal(breaths, 0, 'asleep is nothing going on: no breathing while the window rests, so the clock sleeps between peeks')
  assert.ok(avatar.wakeIn() > 10, `the next peek is far off (${avatar.wakeIn().toFixed(0)} s)`)
  // Reduced effects and smaller levels never peek.
  const calm = new Avatar({ seed: 7, size: 64, live: true, tier: 'lively', effects: 'reduced' })
  calm.doze(true)
  run(calm, 60)
  assert.ok(!calm.clips.some(play => play.name === 'sneak'))
  assert.equal(calm.wakeIn(), Infinity)
})

// Nonzero winding of the body's loops around a point.
// Whether a point is on a decal: inside any of its facets.
const onDecal = (paints, x, y) => paints.some((paint) => {
  for (let k = 0, from = 0; k < paint.count; from = paint.ends[k], k += 1) {
    let inside = false
    for (let i = from, j = paint.ends[k] - 2; i < paint.ends[k]; j = i, i += 2) {
      const [x0, y0, x1, y1] = [paint.points[j], paint.points[j + 1], paint.points[i], paint.points[i + 1]]
      if ((y0 > y) !== (y1 > y) && x < x0 + ((y - y0) * (x1 - x0)) / (y1 - y0)) inside = !inside
    }
    if (inside) return true
  }
  return false
})
const winding = (loops, x, y) => {
  let w = 0
  for (const pts of loops) {
    const n = pts.length / 2
    for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
      const ax = pts[j * 2], ay = pts[j * 2 + 1], bx = pts[i * 2], by = pts[i * 2 + 1]
      if ((ay <= y) !== (by <= y)) {
        const cross = (bx - ax) * (y - ay) - (x - ax) * (by - ay)
        if (ay <= y && cross > 0) w += 1
        else if (ay > y && cross < 0) w -= 1
      }
    }
  }
  return w
}

test('a glance moves the eyes across the face at their own size, and they stay on it', () => {
  for (const id of [...PICKER_SHAPES, 'magnet', 'ring', 'gem']) {
    const rig = rigFor(id, SHAPES[id])
    const rest = shapesOf(rig, REST)
    const restBoxes = rest.eyes.map(box)
    let moved = 0
    for (const [gx, gy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [0.6, -0.8], [-0.3, 0.9]]) {
      const shapes = shapesOf(rig, { ...REST, gx, gy })
      shapes.eyes.forEach((eye, index) => {
        const b = box(eye)
        const was = restBoxes[index]
        assert.ok(Math.abs((b.x1 - b.x0) - (was.x1 - was.x0)) < 1e-3 && Math.abs((b.y1 - b.y0) - (was.y1 - was.y0)) < 1e-3, `${id} eye ${index} keeps its size looking ${gx},${gy}`)
        moved = Math.max(moved, Math.hypot(b.cx - was.cx, b.cy - was.cy))
      })
      // No point of an eye that is on the body leaves it, or lands on a decal; bigger
      // eyes look less far. Closed eyes, a wink and a peek are drawn wider than the open
      // eye the room is measured for, so they are held to the same.
      for (const [label, more] of [['', {}], ['surprised', { face: FACES.surprised, pupil: 0.1 }], ['sleepy', { face: FACES.sleepy }], ['happy', { face: FACES.happy }], ['wink', { face: FACES.wink }], ['peek', { face: FACES.peek }]]) {
        const still = shapesOf(rig, { ...REST, ...more }).eyes
        shapesOf(rig, { ...REST, ...more, gx, gy }).eyes.forEach((eye, index) => {
          for (let i = 0; i < eye.length; i += 2) {
            const [sx, sy] = [still[index][i], still[index][i + 1]]
            if (winding(rest.body, sx, sy) !== 0) assert.notEqual(winding(rest.body, eye[i], eye[i + 1]), 0, `${id} eye ${index} stays on the body looking ${gx},${gy} ${label}`)
            if (!onDecal(rest.paints, sx, sy)) assert.ok(!onDecal(rest.paints, eye[i], eye[i + 1]), `${id} eye ${index} keeps off the decal looking ${gx},${gy} ${label}`)
          }
        })
      }
    }
    assert.ok(moved > 3, `${id} eyes can look somewhere (${moved.toFixed(1)})`)
  }
})
