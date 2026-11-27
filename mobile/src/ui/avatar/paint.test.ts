// The canvas stand-in (paint.ts) runs the desktop's own drawing (render.js drawShapes)
// on real models and frames. What it writes down must be the shapes the desktop draws:
// the same path data render.js gives for SVG (pathsOf), laid over each other as the
// canvas lays them (decals on the body, confetti behind it, the eyes cut through,
// flourishes on top).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Avatar } from '../../../../ds-bot/src/client/avatar/engine.js'
import { rigFor } from '../../../../ds-bot/src/client/avatar/rig.js'
import { pathsOf, shapesOf } from '../../../../ds-bot/src/client/avatar/render.js'
import { SHAPES } from '../../../../ds-bot/src/client/characters.js'
import { Gradient, PaintRecorder, paintShapes, type Node, type Op } from './paint.ts'

type Rig = NonNullable<ReturnType<typeof rigFor>>
const rigOf = (shape: string) => rigFor(shape, (SHAPES as Record<string, unknown>)[shape]) as Rig

// Plays a state for `seconds` and returns the shapes of the last frame.
function shapesAfter(shape: string, { state = 'idle', size = 64, seconds = 0.5, act }: { state?: string; size?: number; seconds?: number; act?: (engine: InstanceType<typeof Avatar>) => void } = {}) {
  const engine = new Avatar({ seed: 7, size, state: 'idle' })
  engine.setState(state)
  act?.(engine)
  for (let t = 0; t < seconds; t += 1 / 60) engine.tick(1 / 60)
  return shapesOf(rigOf(shape), engine.frame, {})
}

const ops = (nodes: Node[]): Op[] => nodes.flatMap(node => ('op' in node ? [node.op] : ops(node.nodes)))

test('the body, the decals and the eyes are the path data the desktop gives for SVG', () => {
  for (const shape of ['whale', 'octopus', 'star', 'ring']) {
    const shapes = shapesAfter(shape, { state: 'working' })
    const expected = pathsOf(shapes)
    const scene = paintShapes(shapes, '#4f7df3')
    // The eyes cut through everything drawn before them.
    assert.equal(scene.length, 1, `${shape}: one cut layer`)
    const cut = scene[0]
    assert.ok('cut' in cut)
    assert.equal(cut.cut.map(part => part.d).join(''), expected.eyes, `${shape}: the eyes`)
    const [body, ...rest] = cut.nodes
    assert.ok('op' in body)
    assert.equal(body.op.d, expected.body, `${shape}: the body`)
    assert.equal(body.op.fill, '#4f7df3')
    // Decals: each one painted only where the body is.
    const decals = expected.paints.filter((paint: { d: string }) => paint.d !== '')
    if (decals.length === 0) { assert.equal(rest.length, 0); continue }
    const clip = rest[0]
    assert.ok('clip' in clip, `${shape}: decals are clipped to the body`)
    assert.equal(clip.clip, expected.body)
    assert.deepEqual(clip.nodes.map(node => 'op' in node && [node.op.d, node.op.fill, node.op.alpha]), decals.map((paint: { d: string; fill: string; opacity: number }) => [paint.d, paint.fill, paint.opacity]))
  }
})

test('a gradient body keeps the page gradient over the box', () => {
  const shapes = shapesAfter('cloud', { state: 'thinking' })
  const scene = paintShapes(shapes, [[0, '#A4FFB0'], [0.42, '#00F0E4'], [1, '#2E9EF7']])
  const body = ops(scene)[0]
  assert.ok(body.fill instanceof Gradient)
  assert.deepEqual([body.fill.from, body.fill.to], [[18, 10], [78, 92]])
  assert.deepEqual(body.fill.stops.map(([offset]) => offset), [0, 0.42, 1])
})

test('a thinking hero mark draws its dots on top, not cut by the eyes', () => {
  const shapes = shapesAfter('bear', { state: 'thinking', seconds: 1.2 })
  assert.equal(shapes.accent?.kind, 'dots')
  const scene = paintShapes(shapes, '#e5484d')
  assert.ok('cut' in scene[0])
  const dots = scene.slice(1)
  assert.equal(dots.length, 3, 'three dots after the cut layer')
  for (const dot of dots) {
    assert.ok('op' in dot)
    assert.equal(dot.op.fill, '#e5484d')
    assert.ok(dot.op.alpha > 0 && dot.op.alpha <= 1)
    assert.match(dot.op.d, /^M[-\d. ]+(C[-\d. ]+){4}$/, 'a full circle in four curves')
  }
})

test('confetti goes behind the body and is cut by the eyes with it', () => {
  // Two quick pokes spin; a spin throws confetti, which falls on after the spin, when
  // the eyes face the viewer again.
  const engine = new Avatar({ seed: 7, size: 64, state: 'idle' })
  engine.poke()
  engine.tick(0.2)
  engine.poke()
  let shapes = null
  for (let t = 0; t < 2 && !shapes; t += 1 / 60) {
    engine.tick(1 / 60)
    const frame = shapesOf(rigOf('puppy'), engine.frame, {})
    if (frame.accent?.kind === 'confetti' && frame.eyes.length > 0 && ((engine.frame.accent as { t: number } | null)?.t ?? 0) > 0.4) shapes = frame
  }
  assert.ok(shapes, 'a frame with confetti in the air and the eyes in view')
  const scene = paintShapes(shapes, '#30a46c', ['#f00', '#0f0', '#00f', '#ff0', '#f0f'])
  assert.equal(scene.length, 1)
  const cut = scene[0]
  assert.ok('cut' in cut, 'the eyes cut through the body and the confetti')
  const bodyAt = cut.nodes.findIndex(node => 'op' in node && node.op.d === pathsOf(shapes).body)
  assert.ok(bodyAt > 0, 'confetti pieces come before (under) the body')
  const pieces = cut.nodes.slice(0, bodyAt).map(node => ('op' in node ? node.op : null))
  assert.ok(pieces.every(op => op !== null && (op.fill !== undefined || (op.stroke !== undefined && op.width! > 0))))
  assert.ok(pieces.some(op => op!.stroke !== undefined), 'with streamers')
})

test('the stand-in follows the canvas: transforms, save and restore, arcs', () => {
  const c = new PaintRecorder()
  c.save()
  c.translate(10, 20)
  c.rotate(Math.PI / 2)
  c.globalAlpha = 0.5
  c.fillStyle = '#123456'
  c.fillRect(0, 0, 2, 1)
  c.restore()
  c.beginPath()
  c.arc(50, 50, 10, 0, Math.PI * 2)
  c.fill()
  c.strokeStyle = '#abcdef'
  c.lineWidth = 2
  c.scale(3, 3)
  c.beginPath()
  c.moveTo(0, 0)
  c.lineTo(1, 1)
  c.stroke()
  const [rect, circle, line] = ops(c.scene())
  // The rectangle turned a quarter about (10, 20): x runs down, y runs left.
  assert.equal(rect.d, 'M10 20L10 22L9 22L9 20Z')
  assert.equal(rect.alpha, 0.5)
  assert.equal(circle.alpha, 1, 'restore brings the alpha back')
  assert.ok(circle.d.startsWith('M60 50C'))
  assert.ok(circle.d.endsWith(' 60 50'))
  assert.equal(line.width, 6, 'a line grows with the scale')
  assert.equal(line.d, 'M0 0L3 3')
})
