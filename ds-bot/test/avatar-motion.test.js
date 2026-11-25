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
import { FACES, eyePolygons } from '../src/client/avatar/face.js'
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
  assert.match(paths.eyes, /Z$/)
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

test('a resting window starts nothing new, and a lively mark dozes off and wakes', () => {
  const avatar = new Avatar({ seed: 6, size: 44, live: true, tier: 'lively' })
  avatar.setState('working')
  avatar.rest(true)
  run(avatar, 3)
  assert.equal(avatar.clips.length, 0)
  assert.equal(avatar.wakeIn(), Infinity)
  avatar.rest(false)
  run(avatar, 2)
  assert.ok(avatar.clips.length > 0 || avatar.wakeIn() < 1)
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

test('a spin throws confetti that stays on the canvas; a bounce and reduced effects throw none', () => {
  const avatar = new Avatar({ seed: 9, size: 64 })
  avatar.poke()
  assert.equal(avatar.frame.accent, null, 'a single poke only bounces')
  run(avatar, 0.3)
  avatar.poke()
  assert.equal(avatar.frame.accent?.kind, 'confetti')
  const { seed } = avatar.frame.accent
  run(avatar, 1)
  assert.equal(avatar.frame.accent?.kind, 'confetti')
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
  for (let t = 0; t < 1.7; t += 0.05) drawShapes(ctx, { body: [], paints: [], eyes: [], accent: { kind: 'confetti', t, seed }, offset: [0, 0] }, '#000', ['#111'])
  assert.ok(at.length > 0)
  for (const [x, y] of at) assert.ok(x > -25 && x < 125 && y > -25 && y < 125, `piece at ${x.toFixed(0)}, ${y.toFixed(0)}`)
  const calm = new Avatar({ seed: 9, size: 64, effects: 'reduced' })
  for (let i = 0; i < 3; i += 1) { calm.poke(); run(calm, 0.8) }
  assert.equal(calm.frame.accent, null)
})

test('asleep, a lively mark peeks now and then, less often the longer it sleeps, also while the window rests', () => {
  const avatar = new Avatar({ seed: 7, size: 64, live: true, tier: 'lively' })
  avatar.rest(true)
  avatar.doze(true)
  const peeks = []
  let peeked = false
  let opened = false
  for (let t = 0; t < 240; t += 1 / 30) {
    // Ticked the way the clock does: frames while moving, else a jump to the next move.
    const wait = avatar.wakeIn()
    avatar.tick(wait === 0 ? 1 / 30 : Math.min(wait + 0.01, 5))
    if (avatar.clips.some(play => play.name === 'sneak') && !peeked) peeks.push(avatar.time)
    peeked = avatar.clips.some(play => play.name === 'sneak')
    const shown = avatar.shownFace()
    if (shown.filter(eye => eye.kind === 'capsule').length === 1) opened = true
  }
  assert.ok(opened, 'one eye opens, the other stays shut')
  assert.ok(peeks.length >= 3, `peeks at ${peeks.map(t => t.toFixed(0))}`)
  const gaps = peeks.slice(1).map((t, i) => t - peeks[i])
  for (let i = 1; i < gaps.length; i += 1) assert.ok(gaps[i] > gaps[i - 1], `gaps grow: ${gaps.map(g => g.toFixed(0))}`)
  assert.equal(avatar.state, 'sleeping')
  assert.ok(Number.isFinite(avatar.wakeIn()), 'the next peek wakes the clock')
  // Reduced effects and smaller levels never peek.
  const calm = new Avatar({ seed: 7, size: 64, live: true, tier: 'lively', effects: 'reduced' })
  calm.doze(true)
  run(calm, 60)
  assert.ok(!calm.clips.some(play => play.name === 'sneak'))
  assert.equal(calm.wakeIn(), Infinity)
})

// Nonzero winding of the body's loops around a point.
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
      // No point of an eye that is on the body leaves it; bigger eyes look less far.
      for (const big of [{}, { face: FACES.surprised, pupil: 0.1 }]) {
        const still = shapesOf(rig, { ...REST, ...big }).eyes
        shapesOf(rig, { ...REST, ...big, gx, gy }).eyes.forEach((eye, index) => {
          for (let i = 0; i < eye.length; i += 2) {
            if (winding(rest.body, still[index][i], still[index][i + 1]) === 0) continue
            assert.notEqual(winding(rest.body, eye[i], eye[i + 1]), 0, `${id} eye ${index} stays on the body looking ${gx},${gy}${big.face ? ', surprised' : ''}`)
          }
        })
      }
    }
    assert.ok(moved > 3, `${id} eyes can look somewhere (${moved.toFixed(1)})`)
  }
})
